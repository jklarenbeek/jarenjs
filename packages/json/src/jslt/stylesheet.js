//#region Jaren JSLT stylesheet normalizer
// Validates the closed stylesheet vocabulary, partitions rules by mode,
// and precomputes conflict order. The output is frozen data only; path,
// schema, and body closures are compiled by dispatch.js.

import { JsltCompileError } from './errors.js';
import { failerFor } from '../errors.js';
import { encodeJSONPointerSegment } from '../pointer.js';
import { isJsonObject } from '@jarenjs/core/object';

const hasOwn = Object.hasOwn;
const ENVELOPE_KEYS = new Set(['$jslt', 'rules', 'unmatched', 'modes']);
const RULE_KEYS = new Set(['match', 'mode', 'priority', 'body']);
const MATCH_KEYS = new Set(['path', 'schema']);
const MODE_KEYS = new Set(['unmatched']);

const fail = failerFor(JsltCompileError);

function isDisposition(value) {
  return value === 'share' || value === 'fresh' || value === 'error';
}

function normalizeModes(value, docPath) {
  if (!isJsonObject(value))
    fail('JT0001', "'modes' must be an object", docPath);
  const modes = new Map();
  const names = Object.keys(value);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const modePath = docPath + '/' + encodeJSONPointerSegment(name);
    const config = value[name];
    if (!isJsonObject(config))
      fail('JT0001', `mode '${name}' must be an object`, modePath);
    const keys = Object.keys(config);
    for (let j = 0; j < keys.length; j++) {
      if (!MODE_KEYS.has(keys[j]))
        fail('JT0001', `unknown mode member '${keys[j]}'`,
          modePath + '/' + encodeJSONPointerSegment(keys[j]));
    }
    if (!hasOwn(config, 'unmatched'))
      fail('JT0001', `mode '${name}' requires 'unmatched'`, modePath + '/unmatched');
    if (!isDisposition(config.unmatched))
      fail('JT0001', `invalid unmatched disposition ${JSON.stringify(config.unmatched)}`,
        modePath + '/unmatched');
    modes.set(name, Object.freeze({
      unmatched: config.unmatched,
      unmatchedPath: modePath + '/unmatched',
    }));
  }
  return modes;
}

function normalizeMatch(value, matchPath) {
  if (typeof value === 'string') {
    return Object.freeze({
      path: value,
      pathDocPath: matchPath,
      schema: null,
      schemaPresent: false,
      schemaDocPath: '',
    });
  }
  if (!isJsonObject(value))
    fail('JT0003', "'match' must be a JSONPath string or an object", matchPath);

  const keys = Object.keys(value);
  if (keys.length === 0)
    fail('JT0003', "'match' cannot be an empty object", matchPath);
  for (let i = 0; i < keys.length; i++) {
    if (!MATCH_KEYS.has(keys[i]))
      fail('JT0003', `unknown match member '${keys[i]}'`,
        matchPath + '/' + encodeJSONPointerSegment(keys[i]));
  }
  const hasPath = hasOwn(value, 'path');
  const hasSchema = hasOwn(value, 'schema');
  if (!hasPath && !hasSchema)
    fail('JT0003', "'match' requires 'path' and/or 'schema'", matchPath);
  if (hasPath && typeof value.path !== 'string')
    fail('JT0003', "'match.path' must be a JSONPath string", matchPath + '/path');

  return Object.freeze({
    path: hasPath ? value.path : null,
    pathDocPath: hasPath ? matchPath + '/path' : '',
    schema: hasSchema ? value.schema : null,
    schemaPresent: hasSchema,
    schemaDocPath: hasSchema ? matchPath + '/schema' : '',
  });
}

function normalizeRule(value, index, rulesPath) {
  const rulePath = rulesPath + '/' + index;
  if (!isJsonObject(value))
    fail('JT0002', 'a stylesheet rule must be an object', rulePath);

  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    if (!RULE_KEYS.has(keys[i]))
      fail('JT0002', `unknown rule member '${keys[i]}'`,
        rulePath + '/' + encodeJSONPointerSegment(keys[i]));
  }
  if (!hasOwn(value, 'body'))
    fail('JT0002', "a stylesheet rule requires 'body'", rulePath + '/body');
  if (hasOwn(value, 'mode') && typeof value.mode !== 'string')
    fail('JT0002', "'mode' must be a string", rulePath + '/mode');
  if (hasOwn(value, 'priority')
    && (typeof value.priority !== 'number' || !Number.isFinite(value.priority)))
    fail('JT0002', "'priority' must be a finite JSON number", rulePath + '/priority');

  const match = hasOwn(value, 'match')
    ? normalizeMatch(value.match, rulePath + '/match')
    : null;
  const pathCount = match !== null && match.path !== null ? 1 : 0;
  const schemaCount = match !== null && match.schemaPresent ? 1 : 0;
  const defaultPriority = pathCount + schemaCount === 2
    ? 1
    : (pathCount + schemaCount === 1 ? 0 : -1);

  return Object.freeze({
    index,
    docPath: rulePath,
    bodyDocPath: rulePath + '/body',
    body: value.body,
    mode: hasOwn(value, 'mode') ? value.mode : '',
    priority: hasOwn(value, 'priority') ? value.priority : defaultPriority,
    match,
  });
}

/**
 * Normalize a frozen JSLT stylesheet document into a frozen, closure-free
 * model with ranked per-mode rule arrays.
 * @param {any} doc - deeply frozen stylesheet document
 * @returns {object} frozen stylesheet model
 * @throws {JsltCompileError} on JT0001-JT0004 shape errors
 */
export function normalizeJsltStylesheet(doc) {
  let sourceRules;
  let rulesPath;
  let unmatched = 'share';
  let unmatchedPath = '';
  let declaredModes = new Map();

  if (Array.isArray(doc)) {
    sourceRules = doc;
    rulesPath = '';
  }
  else if (isJsonObject(doc)) {
    const keys = Object.keys(doc);
    for (let i = 0; i < keys.length; i++) {
      if (!ENVELOPE_KEYS.has(keys[i]))
        fail('JT0001', `unknown stylesheet member '${keys[i]}'`,
          '/' + encodeJSONPointerSegment(keys[i]));
    }
    if (!hasOwn(doc, '$jslt'))
      fail('JT0001', "the stylesheet envelope requires '$jslt'", '/$jslt');
    if (doc.$jslt !== '0.1')
      fail('JT0004', `unknown JSLT format version ${JSON.stringify(doc.$jslt)}`, '/$jslt');
    if (!hasOwn(doc, 'rules'))
      fail('JT0001', "the stylesheet envelope requires 'rules'", '/rules');
    if (!Array.isArray(doc.rules))
      fail('JT0001', "'rules' must be an array", '/rules');
    if (hasOwn(doc, 'unmatched')) {
      if (!isDisposition(doc.unmatched))
        fail('JT0001', `invalid unmatched disposition ${JSON.stringify(doc.unmatched)}`,
          '/unmatched');
      unmatched = doc.unmatched;
      unmatchedPath = '/unmatched';
    }
    if (hasOwn(doc, 'modes'))
      declaredModes = normalizeModes(doc.modes, '/modes');
    sourceRules = doc.rules;
    rulesPath = '/rules';
  }
  else {
    fail('JT0001', 'a stylesheet must be a rule array or a version envelope', '');
  }

  const rules = new Array(sourceRules.length);
  const rulesByMode = new Map();
  rulesByMode.set('', []);
  let anyPathRule = false;
  for (let i = 0; i < sourceRules.length; i++) {
    const rule = normalizeRule(sourceRules[i], i, rulesPath);
    rules[i] = rule;
    let modeRules = rulesByMode.get(rule.mode);
    if (modeRules === undefined) {
      modeRules = [];
      rulesByMode.set(rule.mode, modeRules);
    }
    modeRules.push(rule);
    if (rule.match !== null && rule.match.path !== null)
      anyPathRule = true;
  }

  for (const name of declaredModes.keys()) {
    if (!rulesByMode.has(name))
      rulesByMode.set(name, []);
  }

  const modes = [];
  for (const [name, modeRules] of rulesByMode) {
    modeRules.sort((a, b) => b.priority - a.priority || b.index - a.index);
    const declared = declaredModes.get(name);
    modes.push(Object.freeze({
      name,
      unmatched: declared !== undefined
        ? declared.unmatched
        : unmatched,
      unmatchedPath: declared !== undefined
        ? declared.unmatchedPath
        : unmatchedPath,
      rules: Object.freeze(modeRules),
    }));
  }

  return Object.freeze({
    rules: Object.freeze(rules),
    modes: Object.freeze(modes),
    unmatched,
    unmatchedPath,
    anyPathRule,
  });
}

//#endregion
