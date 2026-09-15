import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import WebTorrent from 'webtorrent';
import { Bonjour } from 'bonjour-service';
import multicastDns from 'multicast-dns';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 3000);
const lanPin = String(process.env.LAN_PIN || '');
const lanOnly = process.env.LAN_ONLY !== 'false';
const lanHostname = process.env.LAN_HOSTNAME || 'torrent-streamer.local';
const client = new WebTorrent({ maxConns: 80 });
const activeTranscoders = new Set();
const bonjour = new Bonjour();
const mdns = multicastDns();
let mdnsService;

function lanAddresses() {
  const addresses = new Set();
  for (const interfaces of Object.values(networkInterfaces())) {
    for (const address of interfaces || []) {
      if (address.family === 'IPv4' && !address.internal) addresses.add(address.address);
    }
  }
  return [...addresses];
}

function isLocalAddress(value) {
  const address = String(value || '').replace(/^::ffff:/, '');
  if (address === '::1' || address === '127.0.0.1') return true;
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some(Number.isNaN)) return address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:');
  return octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168);
}

function networkInfo() {
  const hosts = [lanHostname, ...lanAddresses()];
  return {
    hosts,
    urls: hosts.map(host => `http://${host}:${port}`),
    hostname: lanHostname,
    port,
    pinRequired: Boolean(lanPin)
  };
}

mdns.on('query', request => {
  const hostname = lanHostname.toLowerCase().replace(/\.$/, '');
  const answers = request.questions
    .filter(question => question.name.toLowerCase() === hostname && (question.type === 'A' || question.type === 'ANY'))
    .map(() => lanAddresses().map(address => ({ name: lanHostname, type: 'A', ttl: 10, data: address })))
    .flat();
  if (answers.length) mdns.respond({ answers });
});

class TorrentManager {
  constructor(torrentClient) {
    this.client = torrentClient;
    this.sessions = new Map();
  }

  get(infoHash) {
    return this.sessions.get(infoHash.toLowerCase());
  }

  getOrCreate(infoHash, magnet) {
    const normalizedHash = infoHash.toLowerCase();
    const existing = this.get(normalizedHash);
    if (existing) return existing;

    const entry = {
      hash: normalizedHash,
      torrent: undefined,
      error: '',
      viewers: new Set()
    };
    this.sessions.set(normalizedHash, entry);

    try {
      this.client.add(magnet, torrent => {
        entry.torrent = torrent;
        this.sessions.set(torrent.infoHash.toLowerCase(), entry);
        torrent.on('error', error => {
          entry.error = error.message || 'The torrent encountered an error.';
        });
        torrent.on('warning', warning => {
          console.warn(`[torrent ${entry.hash}] ${warning.message || warning}`);
        });
      });
    } catch (error) {
      entry.error = error.message;
    }

    return entry;
  }

  addViewer(infoHash, sessionId) {
    const entry = this.get(infoHash);
    if (!entry) return false;
    entry.viewers.add(sessionId);
    return true;
  }

  removeViewer(infoHash, sessionId) {
    const entry = this.get(infoHash);
    if (!entry) return false;
    if (!entry.viewers.has(sessionId)) return false;
    entry.viewers.delete(sessionId);
    if (entry.viewers.size === 0) this.removeTorrent(infoHash);
    return true;
  }

  removeTorrent(infoHash) {
    const entry = this.get(infoHash);
    if (!entry) return false;
    if (entry.torrent) {
      try {
        const removal = this.client.remove(entry.torrent.infoHash, () => {});
        removal?.catch(error => console.warn(`[torrent ${entry.hash}] cleanup: ${error.message}`));
      } catch (error) {
        console.warn(`[torrent ${entry.hash}] cleanup: ${error.message}`);
      }
    }
    this.sessions.delete(entry.hash);
    return true;
  }

  destroy() {
    this.sessions.clear();
  }
}

const torrentManager = new TorrentManager(client);

function sendJson(response, status, value, headers = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    ...headers
  });
  response.end(body);
}

function isAuthorized(request) {
  if (lanOnly && !isLocalAddress(request.socket.remoteAddress)) return false;
  if (!lanPin) return true;
  const cookies = Object.fromEntries(String(request.headers.cookie || '').split(';').map(value => {
    const separator = value.indexOf('=');
    return separator === -1 ? [value.trim(), ''] : [value.slice(0, separator).trim(), decodeURIComponent(value.slice(separator + 1).trim())];
  }));
  return request.headers['x-lan-pin'] === lanPin || cookies.lan_pin === lanPin;
}

function getBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('Request is too large.'));
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

function normalizeMagnetInput(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  if (/^magnet:/i.test(input)) return input;

  const hash = input.replace(/^urn:btih:/i, '').replace(/\s+/g, '').toLowerCase();
  if (/^[0-9a-f]{40}$/i.test(hash)) return `magnet:?xt=urn:btih:${hash}`;
  return '';
}

function hashFromMagnet(magnet) {
  const match = magnet.match(/urn:btih:([^&]+)/i);
  return match ? decodeURIComponent(match[1]).toLowerCase() : '';
}

function fileInfo(file, index, hash) {
  return {
    index,
    name: file.name,
    length: file.length,
    type: file.name.includes('.') ? `video/${file.name.split('.').pop()}` : 'application/octet-stream',
    streamUrl: /\.(mp4|webm|ogg|m4v)$/i.test(file.name)
      ? `/api/torrents/${hash}/files/${index}`
      : `/api/torrents/${hash}/files/${index}/transcode`
  };
}

function torrentInfo(entry) {
  if (!entry.torrent) {
    return { infoHash: entry.hash, status: entry.error ? 'error' : 'connecting', error: entry.error };
  }

  const { torrent } = entry;
  return {
    infoHash: torrent.infoHash,
    name: torrent.name,
    status: 'ready',
    progress: torrent.progress,
    downloaded: torrent.downloaded,
    length: torrent.length,
    downloadSpeed: torrent.downloadSpeed,
    uploadSpeed: torrent.uploadSpeed,
    numPeers: torrent.numPeers,
    files: torrent.files.map((file, index) => fileInfo(file, index, torrent.infoHash))
  };
}

function addTorrent(magnet) {
  const normalizedMagnet = normalizeMagnetInput(magnet);
  if (!normalizedMagnet) throw new Error('The value is not a valid magnet link or 40-character info hash.');

  const requestedHash = hashFromMagnet(normalizedMagnet);
  if (!requestedHash) throw new Error('The magnet link does not contain a valid info hash.');
  return torrentManager.getOrCreate(requestedHash, normalizedMagnet);
}

function streamFile(request, response, entry, index) {
  const file = entry?.torrent?.files?.[index];
  if (!file) return sendJson(response, 404, { error: 'Torrent file is not ready.' });

  const range = request.headers.range;
  const total = file.length;
  let start = 0;
  let end = total - 1;

  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    if (match) {
      if (match[1]) start = Number(match[1]);
      if (match[2]) end = Number(match[2]);
      else end = total - 1;
      if (!match[1]) start = Math.max(total - Number(match[2]), 0);
    }
  }

  if (start > end || start >= total) {
    response.writeHead(416, { 'Content-Range': `bytes */${total}` });
    return response.end();
  }

  const length = end - start + 1;
  response.writeHead(range ? 206 : 200, {
    'Content-Type': file.name.endsWith('.mp4') ? 'video/mp4' : 'video/*',
    'Content-Length': length,
    'Content-Range': range ? `bytes ${start}-${end}/${total}` : undefined,
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*'
  });

  const stream = file.createReadStream({ start, end });
  stream.on('error', error => {
    if (error.code !== 'PREMATURE_CLOSE' && !response.destroyed) response.destroy(error);
  });
  response.on('close', () => {
    if (!stream.destroyed) stream.destroy();
  });
  stream.pipe(response);
}

function transcodeFile(response, entry, index) {
  const file = entry?.torrent?.files?.[index];
  if (!file) return sendJson(response, 404, { error: 'Torrent file is not ready.' });

  response.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*'
  });

  const ffmpeg = spawn(ffmpegPath, [
    '-loglevel', 'error',
    '-i', 'pipe:0',
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-f', 'mp4',
    'pipe:1'
  ]);
  activeTranscoders.add(ffmpeg);

  const input = file.createReadStream();
  let closed = false;
  const closeTranscoder = () => {
    if (closed) return;
    closed = true;
    activeTranscoders.delete(ffmpeg);
    if (!input.destroyed) input.destroy();
    if (!ffmpeg.killed) ffmpeg.kill('SIGTERM');
  };
  input.on('error', error => {
    if (error.code !== 'PREMATURE_CLOSE' && !response.destroyed) response.destroy(error);
    closeTranscoder();
  });
  ffmpeg.stdout.on('error', error => {
    if (!response.destroyed) response.destroy(error);
    closeTranscoder();
  });
  response.on('close', () => {
    closeTranscoder();
  });
  ffmpeg.stdout.pipe(response);
  input.pipe(ffmpeg.stdin);
  ffmpeg.stdin.on('error', error => {
    if (error.code !== 'EPIPE' && !response.destroyed) response.destroy(error);
  });
  ffmpeg.on('error', error => {
    if (!response.headersSent) sendJson(response, 500, { error: error.message });
    else response.destroy(error);
    closeTranscoder();
  });
  ffmpeg.on('close', () => activeTranscoders.delete(ffmpeg));
}

async function handleApi(request, response, pathname) {
  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Range'
    });
    return response.end();
  }

  if (request.method === 'GET' && pathname === '/api/network') {
    return sendJson(response, 200, networkInfo());
  }

  if (!isAuthorized(request)) {
    return sendJson(response, lanPin ? 401 : 403, {
      error: lanPin ? 'A valid LAN PIN is required.' : 'This server only accepts local-network connections.'
    });
  }

  if (request.method === 'POST' && pathname === '/api/torrents') {
    try {
      const body = JSON.parse(await getBody(request));
      const magnet = normalizeMagnetInput(body.magnet || body.infoHash || body.torrentId || '');
      if (!magnet) return sendJson(response, 400, { error: 'A magnet link or 40-character info hash is required.' });
      const entry = addTorrent(magnet);
      const sessionId = randomUUID();
      torrentManager.addViewer(entry.hash, sessionId);
      const headers = lanPin ? { 'Set-Cookie': `lan_pin=${encodeURIComponent(lanPin)}; Path=/; HttpOnly; SameSite=Strict` } : {};
      return sendJson(response, 202, { ...torrentInfo(entry), sessionId }, headers);
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  const match = pathname.match(/^\/api\/torrents\/([^/]+)(?:\/files\/(\d+)(\/transcode)?)?$/);
  if (!match) return sendJson(response, 404, { error: 'API route not found.' });

  const infoHash = decodeURIComponent(match[1]);
  const entry = torrentManager.get(infoHash);
  if (!entry) return sendJson(response, 404, { error: 'Torrent not found.' });

  if (match[2] !== undefined && request.method === 'GET') {
    if (match[3]) return transcodeFile(response, entry, Number(match[2]));
    return streamFile(request, response, entry, Number(match[2]));
  }
  if (request.method === 'GET') return sendJson(response, 200, torrentInfo(entry));
  if (request.method === 'DELETE') {
    const sessionId = new URL(request.url, `http://${request.headers.host || 'localhost'}`).searchParams.get('sessionId');
    if (!sessionId) return sendJson(response, 400, { error: 'A viewer session ID is required.' });
    if (!torrentManager.removeViewer(infoHash, sessionId)) {
      return sendJson(response, 403, { error: 'The viewer session is not active.' });
    }
    return sendJson(response, 200, { ok: true });
  }

  return sendJson(response, 405, { error: 'Method not allowed.' });
}

function serveStatic(request, response, pathname) {
  const dist = join(root, 'dist', 'lan-torrent-streamer', 'browser');
  const requested = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = normalize(join(dist, requested));
  const safePath = filePath.startsWith(dist) ? filePath : join(dist, 'index.html');
  const path = existsSync(safePath) ? safePath : join(dist, 'index.html');

  if (!existsSync(path)) {
    response.writeHead(404);
    return response.end('Build the Angular app first with npm run build.');
  }

  const contentTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  response.writeHead(200, { 'Content-Type': contentTypes[extname(path)] || 'application/octet-stream' });
  createReadStream(path).pipe(response);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleApi(request, response, url.pathname);
  if (request.method === 'GET') return serveStatic(request, response, url.pathname);
  response.writeHead(405);
  response.end();
});

server.listen(port, '0.0.0.0', () => {
  console.log(`LAN Torrent Streamer backend listening on http://0.0.0.0:${port}`);
  const serviceName = `${lanHostname.replace(/\.local$/, '')}-${port}`;
  mdnsService = bonjour.publish({ name: serviceName, type: 'http', port });
  console.log(`LAN discovery available at http://${lanHostname}:${port}`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down gracefully.`);
  server.close(() => {
    mdnsService?.stop();
    bonjour.destroy();
    mdns.destroy();
    torrentManager.destroy();
    for (const ffmpeg of activeTranscoders) {
      if (!ffmpeg.killed) ffmpeg.kill('SIGTERM');
    }
    client.destroy(() => process.exit(0));
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
