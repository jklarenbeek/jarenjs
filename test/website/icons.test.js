//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Read only the generator's fixed RGBA8, non-interlaced, unfiltered PNG format. */
function pixels(path, size) {
  const png = readFileSync(path);
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  assert.equal(png.readUInt32BE(16), size);
  assert.equal(png.readUInt32BE(20), size);
  assert.deepEqual([...png.subarray(24, 29)], [8, 6, 0, 0, 0]);
  const compressed = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') compressed.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const rows = inflateSync(Buffer.concat(compressed));
  assert.equal(rows.length, size * (size * 4 + 1));
  for (let y = 0; y < size; y++) assert.equal(rows[y * (size * 4 + 1)], 0, 'the icon generator uses filter 0');
  assert.deepEqual([...rows.subarray(1, 5)], [0x3b, 0x82, 0xf6, 0xff], 'docs/DESIGN.md logo blue');
  return rows;
}

it('PWA icons and their deterministic generator use the current blue logo palette', (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'jaren-icons-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  mkdirSync(join(temp, 'scripts')); mkdirSync(join(temp, 'public'));
  const source = readFileSync(join(root, 'packages/website/scripts/make-icons.js'), 'utf8')
    .replace("'@jarenjs/core/checksum'", JSON.stringify(import.meta.resolve('@jarenjs/core/checksum')));
  const script = join(temp, 'scripts/make-icons.mjs');
  writeFileSync(script, source);
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  for (const size of [192, 512]) {
    const tracked = pixels(join(root, `packages/website/public/icon-${size}.png`), size);
    const generated = pixels(join(temp, `public/icon-${size}.png`), size);
    assert.deepEqual(tracked, generated, `icon-${size}.png is current`);
  }
});
