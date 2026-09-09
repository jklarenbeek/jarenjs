#!/usr/bin/env node
//@ts-check
/**
 * Isolate the forms composition decision's addressing cost. All three
 * contenders project the same expanded field tree to { pointer, value }
 * rows. Compilation and expansion are outside timing, favoring JSLT;
 * this is not a measurement of complete form composition or rendering.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compileJSONPointer, encodeJSONPointerSegment, JSONPOINTER_NOTHING } from '@jarenjs/json/pointer';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';

const stylesheet = [
  { match: '$', body: [{ $apply: '$.fields..[?@.segments]' }] },
  { match: '$.fields..[?@.segments]', body: {
    pointer: '$.pointer',
    value: { $default: [{ $fold: { cursor: '$root.data' }, $for: { segment: '$.segments[*]' },
      $return: { $get: ['$cursor', '$segment'] } }, null] },
  } },
];

/** @param {number} depth @param {number} width */
export function compositionFixture(depth, width) {
  const data = {};
  const fields = { children: [] };
  let current = data;
  let branch = fields;
  const segments = [];
  for (let level = 0; level < depth; level++) {
    const key = `level/${level}~`;
    current[key] = {};
    current = current[key];
    segments.push(key);
    const child = { segments: [...segments], pointer: '/' + segments.map(encodeJSONPointerSegment).join('/'), children: [] };
    branch.children.push(child);
    branch = child;
  }
  current.rows = Array.from({ length: width }, (_, i) => ({ value: i }));
  const rowSegments = [...segments, 'rows'];
  for (let i = 0; i < width; i++) {
    const path = [...rowSegments, i, 'value'];
    branch.children.push({ segments: path, pointer: '/' + path.map((key) => encodeJSONPointerSegment(String(key))).join('/'), children: [] });
  }
  return { data, fields };
}

/** Compile equivalent projectors once over a fixed expanded field tree. */
export function compositionProjectors(fixture) {
  function prepare(field, parentLength) {
    const children = field.children.map((child) => prepare(child, field.segments?.length ?? 0));
    if (field.segments === undefined) return { children, get: (data) => data, pointer: null };
    const suffix = field.segments.slice(parentLength);
    return { children, get: compileJSONPointer('/' + suffix.map((key) => encodeJSONPointerSegment(String(key))).join('/')), pointer: field.pointer };
  }
  const tree = prepare(fixture.fields, 0);
  const transform = compileJsltStylesheet(stylesheet);
  const normalize = (value) => value === JSONPOINTER_NOTHING ? null : value;
  const rows = [];
  function ordered(field) {
    if (field.pointer !== undefined) rows.push({ pointer: field.pointer, get: compileJSONPointer(field.pointer) });
    for (const child of field.children) ordered(child);
  }
  ordered(fixture.fields);
  return {
    rootPointers: (input) => rows.map(({ pointer, get }) => ({ pointer, value: normalize(get(input.data)) })),
    carriedCursors: (input) => {
      const out = [];
      function walk(node, parent) {
        const value = parent === JSONPOINTER_NOTHING ? parent : node.get(parent);
        if (node.pointer !== null) out.push({ pointer: node.pointer, value: normalize(value) });
        for (const child of node.children) walk(child, value);
      }
      walk(tree, input.data);
      return out;
    },
    foldStylesheet: (input) => transform(input),
  };
}

/** Median milliseconds per projection, excluding compilation. */
function measure(run, input) {
  for (let i = 0; i < 100; i++) run(input);
  const samples = [];
  for (let sample = 0; sample < 7; sample++) {
    const start = performance.now();
    for (let i = 0; i < 100; i++) run(input);
    samples.push((performance.now() - start) / 100);
  }
  return samples.sort((a, b) => a - b)[3];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rows = [];
  for (const [depth, width] of [[1, 32], [8, 128], [24, 512]]) {
    const fixture = compositionFixture(depth, width);
    const projectors = compositionProjectors(fixture);
    const expected = projectors.rootPointers(fixture);
    for (const run of Object.values(projectors)) assert.deepEqual(run(fixture), expected);
    rows.push({ depth, width, nodes: expected.length, ...Object.fromEntries(Object.entries(projectors).map(([name, run]) => [name, measure(run, fixture)])) });
  }
  const result = { node: process.version, platform: process.platform, arch: process.arch,
    scope: 'Expanded-field addressing only; compilation and expansion excluded; median milliseconds per projection.', rows };
  writeFileSync(new URL('./forms-composition-result.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}
