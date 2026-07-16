#!/usr/bin/env node

/**
 * QT3 catalog converter (dev-time tooling for the QT3 compliance harness).
 *
 * Reads the W3C QT3 test suite (the git submodule at benchmark/qt3tests/,
 * from https://github.com/w3c/qt3tests) and converts catalog.xml plus every
 * referenced test-set XML file into plain JSON under benchmark/qt3-json/:
 * one JSON file per test-set plus an index.json. The submodule is the
 * source of truth; the JSON is generated and gitignored, and conversion is
 * deterministic (same checkout in, byte-identical JSON out).
 *
 * Preserved per test case: name, description, dependencies (spec/feature/
 * xml-version/...), environment reference or inline environment (sources,
 * params, decimal formats - kept raw), the query text (inline <test> or a
 * file reference, resolved and inlined), and the full result-assertion
 * tree. See benchmark/qt3-README.md.
 *
 * Usage:
 *   node benchmark/tools/qt3-convert.js            # convert everything
 *   node benchmark/tools/qt3-convert.js --quiet    # summary line only
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import { XMLParser } from 'fast-xml-parser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUITE_DIR = path.join(__dirname, '..', 'qt3tests');
const OUTPUT_DIR = path.join(__dirname, '..', 'qt3-json');

//#region XML plumbing (fast-xml-parser preserveOrder shape)

// preserveOrder yields nodes shaped { <tag>: [children...], ':@': {attrs} }
// with text as { '#text': '...' } and CDATA as { __cdata: [{'#text': ...}] }.

// entity processing is done here, not by fast-xml-parser: fxp leaves
// numeric character references ('&#xA;') undecoded while still expanding
// '&amp;' - after which '&amp;#xA;' and '&#xA;' are indistinguishable.
// One left-to-right pass over the raw text is the correct XML semantics.
const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: '',
  removeNSPrefix: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
  processEntities: false,
  cdataPropName: '__cdata',
});

const NAMED_ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeXmlEntities(s) {
  let amp = s.indexOf('&');
  if (amp < 0)
    return s;
  let out = '';
  let i = 0;
  while (amp >= 0) {
    const semi = s.indexOf(';', amp + 1);
    if (semi < 0)
      throw new Error(`unterminated entity reference in ${JSON.stringify(s)}`);
    out += s.slice(i, amp);
    const name = s.slice(amp + 1, semi);
    if (name.charCodeAt(0) === 0x23) { // '#'
      const hex = name.charCodeAt(1) === 0x78 || name.charCodeAt(1) === 0x58; // x/X
      const code = hex ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      if (!Number.isInteger(code))
        throw new Error(`invalid character reference '&${name};'`);
      out += String.fromCodePoint(code);
    }
    else if (NAMED_ENTITIES[name] !== undefined) {
      out += NAMED_ENTITIES[name];
    }
    else {
      throw new Error(`unknown entity reference '&${name};'`);
    }
    i = semi + 1;
    amp = s.indexOf('&', i);
  }
  return out + s.slice(i);
}

function tagOf(node) {
  for (const key of Object.keys(node)) {
    if (key !== ':@')
      return key;
  }
  return undefined;
}

function attrsOf(node) {
  const raw = node[':@'];
  if (raw === undefined)
    return {};
  const attrs = {};
  for (const key of Object.keys(raw))
    attrs[key] = decodeXmlEntities(raw[key]);
  return attrs;
}

function childrenOf(node) {
  const tag = tagOf(node);
  return tag === undefined ? [] : node[tag];
}

/** All text content of a node, CDATA (kept raw) included, in document order. */
function textOf(node) {
  let out = '';
  for (const child of childrenOf(node)) {
    const tag = tagOf(child);
    if (tag === '#text')
      out += decodeXmlEntities(child['#text']);
    else if (tag === '__cdata')
      out += rawTextOf(child);
  }
  return out;
}

function rawTextOf(node) {
  let out = '';
  for (const child of childrenOf(node)) {
    if (tagOf(child) === '#text')
      out += child['#text'];
  }
  return out;
}

/** Child element nodes (text nodes skipped), optionally filtered by tag. */
function elements(node, tag) {
  const out = [];
  for (const child of childrenOf(node)) {
    const t = tagOf(child);
    if (t === undefined || t === '#text' || t === '__cdata')
      continue;
    if (tag === undefined || t === tag)
      out.push(child);
  }
  return out;
}

function firstElement(node, tag) {
  for (const child of childrenOf(node)) {
    if (tagOf(child) === tag)
      return child;
  }
  return undefined;
}

//#endregion

//#region conversion

/** <dependency type value satisfied?/> -> plain object. */
function convertDependency(node) {
  const a = attrsOf(node);
  const dep = { type: a.type, value: a.value };
  if (a.satisfied !== undefined)
    dep.satisfied = a.satisfied;
  return dep;
}

/**
 * <environment> -> plain object grouping child elements by tag, each child
 * kept raw as its attribute map (plus `text` when it has text content).
 * Tags seen in the suite: namespace, schema, source, param, collection,
 * resource, decimal-format, static-base-uri, collation, context-item.
 */
function convertEnvironment(node) {
  const env = {};
  const name = attrsOf(node).name;
  if (name !== undefined)
    env.name = name;
  for (const child of elements(node)) {
    const tag = tagOf(child);
    const entry = { ...attrsOf(child) };
    const text = textOf(child).trim();
    if (text !== '')
      entry.text = text;
    if (tag === 'collection' || tag === 'source') {
      // collections nest <source> children; keep them
      const sources = elements(child, 'source').map((s) => ({ ...attrsOf(s) }));
      if (sources.length > 0)
        entry.sources = sources;
    }
    (env[tag] ??= []).push(entry);
  }
  return env;
}

const COMBINATOR_KINDS = new Set(['all-of', 'any-of', 'not']);

/** Result assertion element -> { kind, code?/value?/attrs?, children? }. */
function convertAssertion(node) {
  const kind = tagOf(node);
  const a = attrsOf(node);
  const out = { kind };
  if (COMBINATOR_KINDS.has(kind)) {
    out.children = elements(node).map(convertAssertion);
    return out;
  }
  if (kind === 'error') {
    out.code = (a.code ?? '').replace(/^err:/, '');
    return out;
  }
  const value = textOf(node);
  if (value !== '')
    out.value = value;
  const attrs = { ...a };
  if (Object.keys(attrs).length > 0)
    out.attrs = attrs;
  return out;
}

/** <test-case> -> plain object; query file refs are resolved and inlined. */
function convertTestCase(node, setDir) {
  const a = attrsOf(node);
  const testCase = { name: a.name };
  if (a.covers !== undefined)
    testCase.covers = a.covers;

  const description = firstElement(node, 'description');
  if (description !== undefined)
    testCase.description = textOf(description).trim();

  const dependencies = elements(node, 'dependency').map(convertDependency);
  if (dependencies.length > 0)
    testCase.dependencies = dependencies;

  const environment = firstElement(node, 'environment');
  if (environment !== undefined) {
    const ref = attrsOf(environment).ref;
    testCase.environment = ref !== undefined ? { ref } : convertEnvironment(environment);
  }

  const modules = elements(node, 'module').map((m) => ({ ...attrsOf(m) }));
  if (modules.length > 0)
    testCase.modules = modules;

  const test = firstElement(node, 'test');
  if (test !== undefined) {
    const file = attrsOf(test).file;
    testCase.test = file !== undefined
      ? fs.readFileSync(path.join(setDir, file), 'utf8').replace(/^\uFEFF/, '')
      : textOf(test);
  }

  const result = firstElement(node, 'result');
  const assertions = result !== undefined ? elements(result) : [];
  if (assertions.length === 1)
    testCase.result = convertAssertion(assertions[0]);
  else if (assertions.length > 1) // not valid QT3, but stay lossless
    testCase.result = { kind: 'all-of', children: assertions.map(convertAssertion) };

  return testCase;
}

function convertTestSet(filePath, setName) {
  const setDir = path.dirname(filePath);
  const doc = parser.parse(fs.readFileSync(filePath, 'utf8'));
  const root = doc.find((n) => tagOf(n) === 'test-set');
  if (root === undefined)
    throw new Error(`no <test-set> element in ${filePath}`);

  const set = { name: setName };
  const description = firstElement(root, 'description');
  if (description !== undefined)
    set.description = textOf(description).trim();

  const dependencies = elements(root, 'dependency').map(convertDependency);
  if (dependencies.length > 0)
    set.dependencies = dependencies;

  const environments = {};
  for (const env of elements(root, 'environment')) {
    const converted = convertEnvironment(env);
    if (converted.name !== undefined)
      environments[converted.name] = converted;
  }
  if (Object.keys(environments).length > 0)
    set.environments = environments;

  set.testCases = elements(root, 'test-case').map((tc) => convertTestCase(tc, setDir));
  return set;
}

//#endregion

//#region main

function suiteCommit() {
  try {
    return execFileSync('git', ['-C', SUITE_DIR, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  }
  catch {
    return null;
  }
}

function main() {
  const quiet = process.argv.includes('--quiet');
  const catalogPath = path.join(SUITE_DIR, 'catalog.xml');
  if (!fs.existsSync(catalogPath)) {
    console.error(`QT3 suite not found at ${catalogPath}.`);
    console.error('The suite is a git submodule; initialize it with:');
    console.error('  git submodule update --init benchmark/qt3tests');
    process.exit(2);
  }

  const catalog = parser.parse(fs.readFileSync(catalogPath, 'utf8'));
  const root = catalog.find((n) => tagOf(n) === 'catalog');

  const catalogEnvironments = {};
  for (const env of elements(root, 'environment')) {
    const converted = convertEnvironment(env);
    if (converted.name !== undefined)
      catalogEnvironments[converted.name] = converted;
  }

  fs.rmSync(OUTPUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const index = {
    suite: 'QT3',
    commit: suiteCommit(),
    environments: catalogEnvironments,
    sets: [],
  };

  const seenNames = new Set();
  let caseCount = 0;
  let duplicateNames = 0;
  for (const entry of elements(root, 'test-set')) {
    const { name, file } = attrsOf(entry);
    const set = convertTestSet(path.join(SUITE_DIR, file), name);
    for (const testCase of set.testCases) {
      if (seenNames.has(testCase.name))
        duplicateNames++;
      seenNames.add(testCase.name);
    }
    caseCount += set.testCases.length;
    const outFile = `${name}.json`;
    fs.writeFileSync(path.join(OUTPUT_DIR, outFile), JSON.stringify(set, null, 1) + '\n');
    index.sets.push({ name, source: file, file: outFile, testCases: set.testCases.length });
    if (!quiet)
      console.log(`${name}: ${set.testCases.length} cases`);
  }

  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.json'), JSON.stringify(index, null, 1) + '\n');
  console.log(`Converted ${index.sets.length} test sets, ${caseCount} test cases -> ${path.relative(process.cwd(), OUTPUT_DIR)}`);
  if (duplicateNames > 0)
    console.warn(`warning: ${duplicateNames} duplicate test-case name(s) across sets (baseline keys are per-name)`);
}

main();

//#endregion
