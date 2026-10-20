//@ts-check
/**
 * Generate the PWA icons (icon-192.png, icon-512.png) with Node APIs
 * and the suite CRC-32 checksum: a full-bleed brand-blue square with a chunky white
 * "J" glyph, written as valid RGBA PNGs through node:zlib. Full-bleed
 * squares serve both `any` and `maskable` purposes, and iOS gets a real
 * PNG for its apple-touch-icon. Run from the repository root: node packages/website/scripts/make-icons.js
 *
 * The same writer draws Radiant OS's icons (os/public/icon-*.png): the
 * radiant figure of `os/public/radiant.svg` — an amber dancer, arms up,
 * outlined in ink, with its motion marks — on the OS's blue, rasterized
 * from signed distances so the edges are smooth and the bytes are the
 * same on every run. The drawing sits inside the maskable safe circle.
 */

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { crc32 } from '@jarenjs/core/checksum';

const BG = [0x3b, 0x82, 0xf6, 0xff]; // docs/DESIGN.md logo blue
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

const OS_BG = [0x25, 0x63, 0xeb]; // the OS blue, the brand's CTA step
const OS_INK = [0x11, 0x13, 0x1c];
const OS_FIGURE = [0xfb, 0xbf, 0x24]; // amber

/** The radiant figure in radiant.svg's 64-unit frame: [x1, y1, x2, y2] segments. */
const OS_RAYS = [[9, 23, 4, 21], [10, 32, 4, 32], [55, 23, 60, 21], [54, 32, 60, 32], [17, 8, 14, 3], [47, 8, 50, 3]];
const OS_BODY = [[32, 29, 32, 43], [32, 29, 16, 16], [32, 29, 48, 16], [32, 43, 23, 57], [32, 43, 41, 57]];
const OS_HEAD = [32, 13];

/** Distance from (px, py) to the segment (x1, y1)–(x2, y2). */
function segmentDistance(px, py, [x1, y1, x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  const ex = px - (x1 + t * dx);
  const ey = py - (y1 + t * dy);
  return Math.sqrt(ex * ex + ey * ey);
}

/** Signed distance to a set of round-capped strokes of half-width `r`, plus an optional disc. */
function strokesDistance(px, py, segments, r, disc) {
  let d = Infinity;
  for (const s of segments) d = Math.min(d, segmentDistance(px, py, s) - r);
  if (disc) {
    const ex = px - OS_HEAD[0];
    const ey = py - OS_HEAD[1];
    d = Math.min(d, Math.sqrt(ex * ex + ey * ey) - disc);
  }
  return d;
}

function renderOsIcon(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = (size / 64) * 0.86; // pixels per unit, inside the maskable safe zone
  const offset = (size - 64 * scale) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5 - offset) / scale;
      const v = (y + 0.5 - offset) / scale;
      const ink = Math.min(strokesDistance(u, v, OS_RAYS, 1.6, 0), strokesDistance(u, v, OS_BODY, 4.2, 6.6));
      const fill = strokesDistance(u, v, OS_BODY, 2.5, 4.6);
      const inkCover = Math.max(0, Math.min(1, 0.5 - ink * scale));
      const fillCover = Math.max(0, Math.min(1, 0.5 - fill * scale));
      const at = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        const under = OS_BG[c] + (OS_INK[c] - OS_BG[c]) * inkCover;
        pixels[at + c] = Math.round(under + (OS_FIGURE[c] - under) * fillCover);
      }
      pixels[at + 3] = 0xff;
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
for (const size of [192, 512]) {
  const path = join(here, '..', 'os', 'public', `icon-${size}.png`);
  const bytes = writePng(path, size, renderOsIcon(size));
  process.stdout.write(`os/icon-${size}.png: ${bytes} bytes\n`);
}
