//@ts-check
/**
 * Generate the PWA icons (icon-192.png, icon-512.png) with zero
 * dependencies: a full-bleed brand-purple square with a chunky white
 * "J" glyph, written as valid RGBA PNGs through node:zlib. Full-bleed
 * squares serve both `any` and `maskable` purposes, and iOS gets a real
 * PNG for its apple-touch-icon. Run: node scripts/make-icons.js
 */

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BG = [0x56, 0x46, 0xd6, 0xff]; // the brand accent
const FG = [0xff, 0xff, 0xff, 0xff];

/** 8×12 glyph mask. */
const GLYPH = [
  'XXXXXXXX',
  'XXXXXXXX',
  '     XX ',
  '     XX ',
  '     XX ',
  '     XX ',
  '     XX ',
  '     XX ',
  'XX   XX ',
  'XX   XX ',
  ' XXXXX  ',
  '  XXX   ',
];

//#region png writing

const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function writePng(path, size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0; // filter: none
    pixels.copy(raw, row + 1, y * size * 4, (y + 1) * size * 4);
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  writeFileSync(path, png);
  return png.length;
}

//#endregion

function renderIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) pixels.set(BG, i * 4);
  const cols = GLYPH[0].length;
  const rows = GLYPH.length;
  const cell = Math.floor((size * 0.62) / rows);
  const originX = Math.floor((size - cols * cell) / 2);
  const originY = Math.floor((size - rows * cell) / 2);
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      if (GLYPH[gy][gx] !== 'X') continue;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const px = originX + gx * cell + x;
          const py = originY + gy * cell + y;
          pixels.set(FG, (py * size + px) * 4);
        }
      }
    }
  }
  return pixels;
}

const here = dirname(fileURLToPath(import.meta.url));
for (const size of [192, 512]) {
  const path = join(here, '..', 'public', `icon-${size}.png`);
  const bytes = writePng(path, size, renderIcon(size));
  process.stdout.write(`icon-${size}.png: ${bytes} bytes\n`);
}
