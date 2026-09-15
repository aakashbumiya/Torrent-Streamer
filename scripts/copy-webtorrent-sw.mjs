import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const source = resolve('node_modules/webtorrent/sw.min.js');
const publicDir = resolve('public');
const target = resolve(publicDir, 'sw.min.js');

mkdirSync(publicDir, { recursive: true });

if (!existsSync(source)) {
  console.warn('WebTorrent service worker was not found. Run npm install first.');
  process.exit(0);
}

copyFileSync(source, target);
console.log('Copied WebTorrent service worker to public/sw.min.js');