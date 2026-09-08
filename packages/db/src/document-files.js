//@ts-check
/**
 * @file Documents on a Node filesystem: the readers that hand a
 * migration one document at a time, and the writer that replaces a file
 * only once every document has survived every step.
 *
 * Two encodings, both walked without holding the collection. **JSONL**
 * is one document per line, so a line boundary is a document boundary.
 * **JSON** is one top-level array, which has no line structure at all —
 * so it is scanned structurally: a character-code walk tracks string,
 * escape and nesting depth and hands back each element's text as it
 * closes, which is the only way to read the second element of a 100 MiB
 * array without parsing the first 99. Neither reader ever holds more
 * than one document plus the chunk it is decoding.
 *
 * The writer is the reason a failed migration cannot corrupt a file. It
 * writes a sibling temporary, flushes it, and renames only when the
 * caller commits — a rename within a directory is atomic, so a reader
 * sees the old bytes or the new ones and never a half-written mix. Any
 * failure aborts instead: the temporary is removed and the original is
 * left byte for byte as it was.
 *
 * Node-only, and reached through `@jarenjs/db/node`: `@jarenjs/db`
 * itself imports no `node:` module, because it runs in a browser too.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

import { DbCompileError } from './errors.js';

/** The document encodings a file may carry. */
export const DOCUMENT_FORMATS = Object.freeze(['json', 'jsonl']);

/**
 * The encoding a path declares by its extension. `.jsonl`/`.ndjson` are
 * line-delimited; everything else is one JSON array.
 * @param {string} file
 * @returns {'json' | 'jsonl'}
 */
export function formatOf(file) {
  const extension = path.extname(file).toLowerCase();
  return extension === '.jsonl' || extension === '.ndjson' ? 'jsonl' : 'json';
}

const refuse = (reason) => new DbCompileError('JD0024', reason);

/**
 * A readable of byte chunks decoded into strings, from a path or from
 * an already-open stream (`-` is standard input).
 * @param {string | AsyncIterable<any>} source
 * @returns {AsyncIterable<string>}
 */
async function* textChunks(source) {
  const stream = typeof source === 'string'
    ? fs.createReadStream(source)
    : source;
  const decoder = new StringDecoder('utf8');
  for await (const chunk of stream) {
    const text = decoder.write(/** @type {Buffer} */ (chunk));
    if (text !== '') yield text;
  }
  const rest = decoder.end();
  if (rest !== '') yield rest;
}

/**
 * The documents of a JSONL source, one line at a time.
 * @param {string | AsyncIterable<any>} source
 * @returns {AsyncGenerator<any>}
 */
export async function* readJsonlDocuments(source) {
  let pending = '';
  let line = 0;
  for await (const chunk of textChunks(source)) {
    pending += chunk;
    let at = pending.indexOf('\n');
    while (at >= 0) {
      const text = pending.slice(0, at).trim();
      pending = pending.slice(at + 1);
      line++;
      if (text !== '') yield parseDocument(text, `line ${line}`);
      at = pending.indexOf('\n');
    }
  }
  const last = pending.trim();
  if (last !== '') yield parseDocument(last, `line ${line + 1}`);
}

/** One document's text, with the position a failure names. */
function parseDocument(text, where) {
  try {
    return JSON.parse(text);
  }
  catch (cause) {
    throw refuse(`${where} is not JSON: ${/** @type {Error} */ (cause).message}`);
  }
}

/**
 * The documents of a top-level JSON array, scanned structurally so that
 * the array is never held whole. Anything but an array at the root is
 * refused: a migration runs over a collection, not over one document.
 * @param {string | AsyncIterable<any>} source
 * @returns {AsyncGenerator<any>}
 */
export async function* readJsonDocuments(source) {
  const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  let started = false;
  let closed = false;
  let element = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let index = 0;
  let separator = false;
  let allowEnd = true;

  for await (const chunk of textChunks(source)) {
    for (let i = 0; i < chunk.length; i++) {
      const character = chunk[i];
      if (!started) {
        if (isSpace(character)) continue;
        if (character !== '[') {
          throw refuse('a JSON document file must hold one top-level ARRAY of '
            + `documents; this one starts with '${character}'`);
        }
        started = true;
        continue;
      }
      if (closed) {
        if (isSpace(character)) continue;
        throw refuse(`trailing content after the closing ']' (found '${character}')`);
      }
      if (element === '') {
        if (isSpace(character)) continue;
        if (separator) {
          if (character === ']') { closed = true; continue; }
          if (character !== ',') throw refuse(`expected ',' or ']' after document ${index - 1}`);
          separator = false;
          allowEnd = false;
          continue;
        }
        if (character === ']' && allowEnd) { closed = true; continue; }
        if (character === ',' || character === ']')
          throw refuse(`expected a document before '${character}'`);
        element = character;
        if (character === '"') inString = true;
        else if (character === '{' || character === '[') depth = 1;
        continue;
      }
      if (inString) {
        element += character;
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') {
          inString = false;
          // a top-level string element ends with its closing quote
          if (depth === 0) {
            yield parseDocument(element, `document ${index++}`);
            element = '';
            separator = true;
          }
        }
        continue;
      }
      if (depth === 0) {
        // a scalar element (number, true, false, null): it ends at the
        // next separator, which belongs to the array and not to it
        if (isSpace(character) || character === ',' || character === ']') {
          yield parseDocument(element, `document ${index++}`);
          element = '';
          separator = true;
          i--; // the array's separator is checked on the next iteration
          continue;
        }
        element += character;
        continue;
      }
      element += character;
      if (character === '"') { inString = true; continue; }
      if (character === '{' || character === '[') { depth++; continue; }
      if (character === '}' || character === ']') {
        depth--;
        if (depth === 0) {
          yield parseDocument(element, `document ${index++}`);
          element = '';
          separator = true;
        }
      }
    }
  }
  if (!started) throw refuse('the source is empty: a JSON document file holds one array');
  if (!closed) throw refuse('the array is never closed — the source ends inside it');
}

/**
 * The documents of a file or stream in the named encoding.
 * @param {string | AsyncIterable<any>} source
 * @param {'json' | 'jsonl'} format
 * @returns {AsyncGenerator<any>}
 */
export function readDocuments(source, format) {
  if (format === 'jsonl') return readJsonlDocuments(source);
  if (format === 'json') return readJsonDocuments(source);
  throw refuse(`unknown document format '${format}' — one of ${DOCUMENT_FORMATS.join(', ')}`);
}

/**
 * A sink that publishes whole or not at all.
 *
 * `write` appends to a sibling temporary; `commit` flushes it, renames
 * it over the target and answers the bytes written; `abort` removes it
 * and leaves the target untouched. A target that is never committed is
 * a target that never changed.
 *
 * @param {string} target - the file to replace
 * @param {'json' | 'jsonl'} format
 * @returns {Promise<{ write: (document: any) => Promise<void>,
 *   commit: () => Promise<{ bytes: number, documents: number }>,
 *   abort: () => Promise<void>, temporary: string }>}
 */
export async function openAtomicTarget(target, format) {
  const directory = path.dirname(path.resolve(target));
  const temporary = path.join(directory,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
  const handle = await fsp.open(temporary, 'wx');
  let documents = 0;
  let bytes = 0;
  let settled = false;

  const put = async (text) => {
    await handle.write(text);
    bytes += Buffer.byteLength(text);
  };
  const discard = async () => {
    try { await handle.close(); }
    catch { /* A failed close must not prevent temporary-file removal. */ }
    await fsp.rm(temporary, { force: true });
  };

  return {
    temporary,
    write: async (document) => {
      const text = JSON.stringify(document);
      if (format === 'jsonl') { documents++; return put(`${text}\n`); }
      return put(documents++ === 0 ? `[\n${text}` : `,\n${text}`);
    },
    commit: async () => {
      if (settled) throw refuse('this target was already settled');
      settled = true;
      try {
        if (format === 'json') await put(documents === 0 ? '[]\n' : '\n]\n');
        // Publish only after the temporary has been durably flushed.
        await handle.sync();
        await handle.close();
        await fsp.rename(temporary, target);
        return { bytes, documents };
      }
      catch (error) {
        try { await discard(); }
        catch (cleanupError) { error.cleanupError = cleanupError; }
        throw error;
      }
    },
    abort: async () => {
      if (settled) return;
      settled = true;
      await discard();
    },
  };
}

/**
 * A sink that writes to an open stream (standard output) and can never
 * be taken back — `abort` is honest that what left has left.
 * @param {{ write: (chunk: string, callback: (error?: any) => void) => any }} stream
 * @param {'json' | 'jsonl'} format
 */
export function openStreamTarget(stream, format) {
  let documents = 0;
  const put = (text) => new Promise((resolve, reject) => {
    stream.write(text, (error) => (error ? reject(error) : resolve(undefined)));
  });
  return {
    temporary: null,
    write: async (document) => {
      const text = JSON.stringify(document);
      if (format === 'jsonl') { documents++; return put(`${text}\n`); }
      return put(documents++ === 0 ? `[\n${text}` : `,\n${text}`);
    },
    commit: async () => {
      if (format === 'json') await put(documents === 0 ? '[]\n' : '\n]\n');
      return { bytes: 0, documents };
    },
    abort: async () => undefined,
  };
}

/** A sink that validates everything and writes nothing (`--check`). */
export function openNullTarget() {
  let documents = 0;
  return {
    temporary: null,
    write: async () => { documents++; },
    commit: async () => ({ bytes: 0, documents }),
    abort: async () => undefined,
  };
}
