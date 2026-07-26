import { describe, it } from 'node:test';
import { ok } from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import {
  parseToml,
  createStreamReader,
  JoslSyntaxError,
  LocalDate,
  LocalTime,
  LocalDateTime,
} from '@jarenjs/josl';

// Official toml-test suite (https://github.com/toml-lang/toml-test), a
// git submodule at benchmark/toml-test-suite/ — initialize it once with
//   git submodule update --init benchmark/toml-test-suite
// The 1.0.0 case list (tests/files-toml-1.0.0) drives both this file and
// the compliance section of benchmark/toml.js.
const SUITE = fileURLToPath(new URL('../../benchmark/toml-test-suite/tests/', import.meta.url));
const FILELIST = join(SUITE, 'files-toml-1.0.0');
const available = existsSync(FILELIST);

// Tests that cannot apply when the input is already a JS string: the
// encoding cases exercise invalid UTF-8/UTF-16 byte sequences, which
// Node's utf8 decoding has already replaced with U+FFFD before the
// parser ever sees them.
const SKIP = new Set([
  'invalid/encoding/bad-codepoint.toml',
  'invalid/encoding/bad-utf8-at-end.toml',
  'invalid/encoding/bad-utf8-in-comment.toml',
  'invalid/encoding/bad-utf8-in-multiline-literal.toml',
  'invalid/encoding/bad-utf8-in-multiline.toml',
  'invalid/encoding/bad-utf8-in-string-literal.toml',
  'invalid/encoding/bad-utf8-in-string.toml',
  'invalid/encoding/utf16-bom.toml',
]);

function listTomlFiles(kind) {
  if (!available)
    return [];
  return readFileSync(FILELIST, 'utf8')
    .split('\n')
    .filter((f) => f.startsWith(`${kind}/`) && f.endsWith('.toml'))
    .sort();
}

//#region typed-JSON comparison

function canonTime(s) {
  // normalize 'T'/space separators and trailing fraction zeros
  let out = s.replace(' ', 'T').replace('t', 'T').replace('z', 'Z');
  const dot = out.indexOf('.');
  if (dot !== -1) {
    let end = dot + 1;
    while (end < out.length && /\d/.test(out[end]))
      end++;
    let frac = out.slice(dot + 1, end).replace(/0+$/, '');
    out = out.slice(0, dot) + (frac.length !== 0 ? `.${frac}` : '') + out.slice(end);
  }
  return out;
}

function scalarMatches(actual, type, value) {
  switch (type) {
    case 'string':
      return actual === value;
    case 'bool':
      return actual === (value === 'true');
    case 'integer':
      return (typeof actual === 'number' && Number.isInteger(actual)
        && BigInt(actual) === BigInt(value))
        || (typeof actual === 'bigint' && actual === BigInt(value));
    case 'float': {
      if (typeof actual !== 'number')
        return false;
      const expected = Number(value.replace('inf', 'Infinity'));
      return (Number.isNaN(expected) && Number.isNaN(actual))
        || Object.is(actual, expected) || actual === expected;
    }
    case 'datetime':
      return actual instanceof Date
        && actual.getTime() === new Date(canonTime(value)).getTime();
    case 'datetime-local':
      return actual instanceof LocalDateTime
        && canonTime(actual.toString()) === canonTime(value);
    case 'date-local':
      return actual instanceof LocalDate && actual.toString() === value;
    case 'time-local':
      return actual instanceof LocalTime
        && canonTime(actual.toString()) === canonTime(value);
    default:
      return false;
  }
}

function deepMatches(actual, expected, path, diffs) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) {
      diffs.push(`${path}: expected array of ${expected.length}`);
      return;
    }
    expected.forEach((e, i) => deepMatches(actual[i], e, `${path}/${i}`, diffs));
    return;
  }
  if (typeof expected.type === 'string' && typeof expected.value === 'string'
    && Object.keys(expected).length === 2) {
    if (!scalarMatches(actual, expected.type, expected.value))
      diffs.push(`${path}: expected ${expected.type} ${expected.value}, got ${String(actual)}`);
    return;
  }
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)
    || actual instanceof Date) {
    diffs.push(`${path}: expected a table`);
    return;
  }
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  if (actualKeys.length !== expectedKeys.length)
    diffs.push(`${path}: expected keys [${expectedKeys}], got [${actualKeys}]`);
  for (const k of expectedKeys)
    if (!Object.hasOwn(actual, k))
      diffs.push(`${path}: missing key '${k}'`);
    else
      deepMatches(actual[k], expected[k], `${path}/${k}`, diffs);
}

//#endregion

describe('josl: toml-test compliance (valid)', () => {
  it('suite submodule is initialized', {
    skip: available
      ? false
      : "run 'git submodule update --init benchmark/toml-test-suite' to enable the 709 compliance cases",
  }, () => ok(available));
  for (const file of listTomlFiles('valid')) {
    it(file, () => {
      const text = readFileSync(join(SUITE, file), 'utf8');
      const expected = JSON.parse(readFileSync(join(SUITE, file.replace(/\.toml$/, '.json')), 'utf8'));
      const actual = parseToml(text);
      const diffs = [];
      deepMatches(actual, expected, '', diffs);
      ok(diffs.length === 0, diffs.join('\n'));
    });
  }
});

describe('josl: toml-test compliance (invalid)', () => {
  for (const file of listTomlFiles('invalid')) {
    it(file, { skip: SKIP.has(file) ? 'byte-level encoding case, unreachable from a JS string' : false }, () => {
      const text = readFileSync(join(SUITE, file), 'utf8');
      let error = null;
      try {
        parseToml(text);
      }
      catch (e) {
        error = e;
      }
      ok(error instanceof JoslSyntaxError,
        `expected a JoslSyntaxError, got ${error === null ? 'success' : error}`);
    });
  }
});

//#region chunked compliance
// parseToml() drives the whole-document path, where the parser finds each
// logical line's end itself. Chunk feeding drives the cutter instead, and
// only these cases exercise it against the official suite — a chunk size
// of 1 splits every token, multi-line string and array at every position.

function feedInChunks(text, size) {
  const reader = createStreamReader({ mode: 'toml' });
  for (let i = 0; i < text.length; i += size)
    reader.feed(text.slice(i, i + size));
  return reader.end();
}

describe('josl: toml-test compliance, chunk-fed (valid)', () => {
  for (const file of listTomlFiles('valid')) {
    it(file, () => {
      const text = readFileSync(join(SUITE, file), 'utf8');
      const expected = JSON.parse(readFileSync(join(SUITE, file.replace(/\.toml$/, '.json')), 'utf8'));
      for (const size of [1, 7]) {
        const diffs = [];
        deepMatches(feedInChunks(text, size), expected, '', diffs);
        ok(diffs.length === 0, `chunk size ${size}:\n${diffs.join('\n')}`);
      }
    });
  }
});

describe('josl: toml-test compliance, chunk-fed (invalid)', () => {
  for (const file of listTomlFiles('invalid')) {
    it(file, { skip: SKIP.has(file) ? 'byte-level encoding case, unreachable from a JS string' : false }, () => {
      const text = readFileSync(join(SUITE, file), 'utf8');
      let error = null;
      try {
        feedInChunks(text, 1);
      }
      catch (e) {
        error = e;
      }
      ok(error instanceof JoslSyntaxError,
        `expected a JoslSyntaxError, got ${error === null ? 'success' : error}`);
    });
  }
});

//#endregion
