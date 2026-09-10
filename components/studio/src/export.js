//@ts-check
/** A deterministic ZIP export. Dependencies are supplied as local bundled
 * bytes, never silently replaced with mutable CDN URLs. */
import { parseProject } from './project.js';

const utf8 = new TextEncoder();
const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
};

/** ZIP method 0 (stored), UTF-8 names, fixed DOS epoch, no ZIP64.
 * @param {Record<string, string | Uint8Array>} files @returns {Uint8Array} */
export function createProjectZip(files) {
  const entries = Object.entries(files).map(([name, content]) => {
    if (!name || name.startsWith('/') || name.includes('\\') || [...name].some((char) => char.charCodeAt(0) < 32)
      || name.split('/').some((part) => part === '..' || part === '.' || part === ''))
      throw new TypeError(`unsafe archive path '${name}'`);
    const path = utf8.encode(name);
    if (path.length > 65535) throw new RangeError('archive path is too long');
    return { path, bytes: typeof content === 'string' ? utf8.encode(content) : content, offset: 0 };
  });
  const size = entries.reduce((n, e) => n + 76 + e.path.length * 2 + e.bytes.length, 22);
  if (entries.length > 65535 || size > 0xffffffff) throw new RangeError('ZIP64 is not supported');
  const out = new Uint8Array(size);
  const data = new DataView(out.buffer);
  let cursor = 0;
  const u16 = (value) => { data.setUint16(cursor, value, true); cursor += 2; };
  const u32 = (value) => { data.setUint32(cursor, value, true); cursor += 4; };
  const bytes = (value) => { out.set(value, cursor); cursor += value.length; };
  for (const entry of entries) {
    entry.offset = cursor;
    u32(0x04034b50); u16(20); u16(0x800); u16(0); u16(0); u16(33);
    u32(crc32(entry.bytes)); u32(entry.bytes.length); u32(entry.bytes.length);
    u16(entry.path.length); u16(0); bytes(entry.path); bytes(entry.bytes);
  }
  const directory = cursor;
  for (const entry of entries) {
    u32(0x02014b50); u16(20); u16(20); u16(0x800); u16(0); u16(0); u16(33);
    u32(crc32(entry.bytes)); u32(entry.bytes.length); u32(entry.bytes.length);
    u16(entry.path.length); u16(0); u16(0); u16(0); u16(0); u32(0); u32(entry.offset); bytes(entry.path);
  }
  const directorySize = cursor - directory;
  u32(0x06054b50); u16(0); u16(0); u16(entries.length); u16(entries.length);
  u32(directorySize); u32(directory); u16(0);
  return out;
}

/** @param {any} project @param {Record<string, string | Uint8Array>} assets */
export function exportProject(project, assets) {
  const normalized = parseProject({ project: project.project, files: project.files,
    ...(project.active ? { active: project.active } : {}), layout: project.layout });
  if (!Object.hasOwn(assets, 'runtime.js')) throw new TypeError('a bundled runtime.js is required');
  const files = {
    'index.html': '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Jaren project</title><link rel="stylesheet" href="runtime/runtime.css"><body><main id="app"></main><script type="module" src="runtime/runtime.js"></script></body></html>',
    'project.json': JSON.stringify(normalized, null, 2),
    'README.md': '# Jaren offline project\n\nUnzip, then serve this directory locally:\n\n    python3 -m http.server 8080 --bind 127.0.0.1\n\nOpen http://127.0.0.1:8080. No package installation or internet connection is needed.\n\nDependency policy: the runtime, worker, SQLite WASM and CSS are bundled from the exporting build, with versions in runtime/versions.json. There are no CDN dependencies. Application-authored external links/assets still require their own hosts. The host grants no application effects or subscriptions; flow effects are logged. Unknown DAG tasks are refused.\n\nproject.json preserves every file, reference, and layout. files/ contains verbatim source text in project order; numeric names preserve arbitrary original names safely in an archive. The runner selects any project file. Model stores are private in-memory SQLite and last until reload; database rows are runtime state and are not included in this source export.\n',
  };
  normalized.files.forEach((file, i) => { files[`files/${String(i + 1).padStart(4, '0')}.json`] = file.text; });
  for (const [name, bytes] of Object.entries(assets)) files[`runtime/${name}`] = bytes;
  return createProjectZip(files);
}
