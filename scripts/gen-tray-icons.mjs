// Generates 32x32 anti-aliased filled-circle tray icons (no dependencies).
import { deflateSync, crc32 } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SIZE = 32;
const COLORS = { on: '#3ddc84', off: '#ff9f2a', emergency: '#ff4d4f', unknown: '#9aa0a6' };
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'tray');

function chunk(type, data) {
  const t = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0);
  return Buffer.concat([len, t, data, crc]);
}

function circlePng(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const c = SIZE / 2, radius = SIZE / 2 - 1;
  const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    const row = y * (SIZE * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x + 0.5 - c, y + 0.5 - c);
      const cov = Math.min(1, Math.max(0, radius - d + 0.5));
      raw.set([r, g, b, Math.round(cov * 255)], row + 1 + x * 4);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const [name, hex] of Object.entries(COLORS)) writeFileSync(join(outDir, `${name}.png`), circlePng(hex));
console.log(`Wrote ${Object.keys(COLORS).length} icons to ${outDir}`);
