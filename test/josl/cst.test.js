import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, ok, throws } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { parseJoslCst, parseTomlCst, parseToml, parseJosl } from '@jarenjs/josl';

const SUITE = fileURLToPath(new URL('../../benchmark/toml-test-suite/tests/', import.meta.url));
const FILELIST = join(SUITE, 'files-toml-1.0.0');
const available = existsSync(FILELIST);

function listValid() {
  if (!available)
    return [];
  return readFileSync(FILELIST, 'utf8')
    .split('\n')
    .filter((f) => f.startsWith('valid/') && f.endsWith('.toml'))
    .sort();
}

//#region round trip

// The whole point of a CST: reprinting an untouched document must return
// the input unchanged, byte for byte, including comments, blank lines,
// alignment, quote styles and number spelling.
describe('josl: cst round-trips the official corpus byte-for-byte', () => {
  it('suite submodule is initialized', {
    skip: available
      ? false
      : "run 'git submodule update --init benchmark/toml-test-suite' to enable the corpus round trip",
  }, () => ok(available));
  for (const file of listValid()) {
    it(file, () => {
      const text = readFileSync(join(SUITE, file), 'utf8');
      const doc = parseTomlCst(text);
      strictEqual(doc.toString(), text);
      deepStrictEqual(doc.toJSON(), parseToml(text));
    });
  }
});

describe('josl: cst preserves document detail', () => {
  it('keeps comments, blank lines and alignment', () => {
    const text = '# leading\n\n[server]\nhost   = "localhost"  # inline\nport   = 8080\n\n# trailing\n';
    strictEqual(parseTomlCst(text).toString(), text);
  });
  it('keeps CRLF line endings', () => {
    const text = '[a]\r\nk = 1\r\n';
    strictEqual(parseTomlCst(text).toString(), text);
  });
  it('keeps the original number and string spelling', () => {
    const text = 'hex = 0xDEAD_beef\nfloat = 1_000.000\nlit = \'raw\\nnot-escaped\'\n';
    strictEqual(parseTomlCst(text).toString(), text);
  });
  it('keeps multi-line strings and arrays as written', () => {
    const text = 'ml = """\n  one\n  two\n"""\narr = [\n  1, # first\n  2,\n]\n';
    strictEqual(parseTomlCst(text).toString(), text);
  });
  it('keeps a byte-order mark instead of silently stripping it', () => {
    const doc = parseTomlCst('﻿k = 1\n');
    strictEqual(doc.toString(), '﻿k = 1\n');
    deepStrictEqual(doc.toJSON(), { k: 1 });
  });
  it('rejects invalid input like the value parser', () => {
    throws(() => parseTomlCst('k = \n'), { name: 'JoslSyntaxError' });
  });
});

//#endregion

//#region editing

describe('josl: cst editing', () => {
  it('replaces only the value bytes, keeping key spacing and comments', () => {
    const text = '[server]\nhost   = "localhost"  # keep me\nport   = 8080\n';
    const doc = parseTomlCst(text);
    doc.set(['server', 'host'], 'example.com');
    strictEqual(doc.toString(),
      '[server]\nhost   = "example.com"  # keep me\nport   = 8080\n');
  });
  it('reports the edited value through toJSON', () => {
    const doc = parseTomlCst('[a]\nk = 1\n');
    doc.set(['a', 'k'], 42);
    deepStrictEqual(doc.toJSON(), { a: { k: 42 } });
    strictEqual(doc.get(['a', 'k']), 42);
  });
  it('appends a missing key to its own section, not the end of the file', () => {
    const text = '[a]\nx = 1\n\n[b]\ny = 2\n';
    const doc = parseTomlCst(text);
    doc.set(['a', 'z'], true);
    strictEqual(doc.toString(), '[a]\nx = 1\nz = true\n\n[b]\ny = 2\n');
    deepStrictEqual(doc.toJSON(), { a: { x: 1, z: true }, b: { y: 2 } });
  });
  it('puts a new root key before the first header', () => {
    const doc = parseTomlCst('[a]\nx = 1\n');
    doc.set(['root'], 'v');
    strictEqual(doc.toString(), 'root = "v"\n[a]\nx = 1\n');
    deepStrictEqual(doc.toJSON(), { root: 'v', a: { x: 1 } });
  });
  it('refuses to add a key to a section that does not exist', () => {
    const doc = parseTomlCst('[a]\nx = 1\n');
    throws(() => doc.set(['missing', 'k'], 1), /no section/);
  });
  it('deletes a pair and leaves standalone comments alone', () => {
    const text = '# keep\n[a]\nx = 1\ny = 2  # goes with y\n';
    const doc = parseTomlCst(text);
    strictEqual(doc.delete(['a', 'y']), true);
    strictEqual(doc.toString(), '# keep\n[a]\nx = 1\n');
    strictEqual(doc.delete(['a', 'nope']), false);
  });
  it('addresses pairs inside an array of tables by index', () => {
    const text = '[[r]]\nid = 1\n\n[[r]]\nid = 2\n';
    const doc = parseTomlCst(text);
    strictEqual(doc.get(['r', 1, 'id']), 2);
    doc.set(['r', 1, 'id'], 99);
    strictEqual(doc.toString(), '[[r]]\nid = 1\n\n[[r]]\nid = 99\n');
  });
  it('edits a dotted key without expanding it', () => {
    const doc = parseTomlCst('a.b.c = 1\n');
    doc.set(['a', 'b', 'c'], 2);
    strictEqual(doc.toString(), 'a.b.c = 2\n');
  });
  it('round-trips an edited document through a fresh parse', () => {
    const doc = parseTomlCst('# c\n[a]\nx = 1\n');
    doc.set(['a', 'x'], [1, 2, 3]);
    deepStrictEqual(parseToml(doc.toString()), { a: { x: [1, 2, 3] } });
  });
});

describe('josl: cst in josl mode', () => {
  it('keeps JOSL-only values as written', () => {
    const text = 'n = null\nbig = 123n\nre = /a+/g\n';
    strictEqual(parseJoslCst(text).toString(), text);
  });
  it('rejects JOSL extensions in toml mode', () => {
    throws(() => parseTomlCst('n = null\n'), { name: 'JoslSyntaxError' });
  });
  it('round-trips a root array document', () => {
    const text = '[[]]\nid = 1\n\n[[]]\nid = 2\n';
    const doc = parseJoslCst(text);
    strictEqual(doc.toString(), text);
    deepStrictEqual(doc.toJSON(), parseJosl(text));
  });
});

//#endregion
