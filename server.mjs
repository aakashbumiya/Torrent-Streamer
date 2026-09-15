import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import WebTorrent from 'webtorrent';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 3000);
const client = new WebTorrent({ maxConns: 80 });
const torrents = new Map();

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*'
  });
  response.end(body);
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

  const existing = torrents.get(requestedHash);
  if (existing) return existing;

  const entry = { hash: requestedHash, torrent: undefined, error: '' };
  torrents.set(requestedHash, entry);

  try {
    client.add(magnet, torrent => {
      entry.torrent = torrent;
      torrents.set(torrent.infoHash.toLowerCase(), entry);
    });
  } catch (error) {
    entry.error = error.message;
  }

  return entry;
}

function getTorrent(hash) {
  return torrents.get(hash.toLowerCase());
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

  const input = file.createReadStream();
  input.on('error', error => {
    if (error.code !== 'PREMATURE_CLOSE' && !response.destroyed) response.destroy(error);
  });
  ffmpeg.stdout.on('error', error => {
    if (!response.destroyed) response.destroy(error);
  });
  response.on('close', () => {
    if (!input.destroyed) input.destroy();
  });
  ffmpeg.stdout.pipe(response);
  input.pipe(ffmpeg.stdin);
  ffmpeg.on('error', error => {
    if (!response.headersSent) sendJson(response, 500, { error: error.message });
    else response.destroy(error);
  });
  response.on('close', () => {
    if (!ffmpeg.killed) ffmpeg.kill('SIGTERM');
  });
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

  if (request.method === 'POST' && pathname === '/api/torrents') {
    try {
      const body = JSON.parse(await getBody(request));
      const magnet = normalizeMagnetInput(body.magnet || body.infoHash || body.torrentId || '');
      if (!magnet) return sendJson(response, 400, { error: 'A magnet link or 40-character info hash is required.' });
      const entry = addTorrent(magnet);
      return sendJson(response, 202, torrentInfo(entry));
    } catch (error) {
      return sendJson(response, 400, { error: error.message });
    }
  }

  const match = pathname.match(/^\/api\/torrents\/([^/]+)(?:\/files\/(\d+)(\/transcode)?)?$/);
  if (!match) return sendJson(response, 404, { error: 'API route not found.' });

  const entry = getTorrent(decodeURIComponent(match[1]));
  if (!entry) return sendJson(response, 404, { error: 'Torrent not found.' });

  if (match[2] !== undefined && request.method === 'GET') {
    if (match[3]) return transcodeFile(response, entry, Number(match[2]));
    return streamFile(request, response, entry, Number(match[2]));
  }
  if (request.method === 'GET') return sendJson(response, 200, torrentInfo(entry));
  if (request.method === 'DELETE') {
    if (entry.torrent) client.remove(entry.torrent.infoHash, () => {});
    torrents.delete(entry.hash);
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
});

process.on('SIGINT', () => {
  client.destroy(() => process.exit(0));
});
