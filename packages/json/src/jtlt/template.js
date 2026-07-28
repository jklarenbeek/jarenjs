//#region Jaren JTLT template normalizer
// Validates the template envelope and rule shape. Segment bodies are
// validated during desugaring (desugar.js); everything the JSLT layer
// checks itself (match details, mode strings inside $apply, query
// vocabulary) is deliberately left to it so the two vocabularies cannot
// drift apart.

import { JtltCompileError } from './errors.js';
import { failerFor } from '../errors.js';
import { encodeJSONPointerSegment } from '../pointer.js';
import { isJsonObject } from '@jarenjs/core/object';

const hasOwn = Object.hasOwn;
const ENVELOPE_KEYS = new Set(['$jtlt', 'output', 'rules']);
const RULE_KEYS = new Set(['match', 'mode', 'priority', 'body']);
const OUTPUT_METHODS = new Set(['text', 'xml']);

// Priorities at or below the floor are reserved for the injected
// built-in rules, which sit at -1e308 - beneath every user rule.
export const RESERVED_PRIORITY_FLOOR = -1e307;

const fail = failerFor(JtltCompileError);

function normalizeRule(value, index, rulesPath) {
  const rulePath = rulesPath + '/' + index;
  if (!isJsonObject(value))
    fail('TL0002', 'a template rule must be an object', rulePath);

  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    if (!RULE_KEYS.has(keys[i]))
      fail('TL0002', `unknown rule member '${keys[i]}'`,
        rulePath + '/' + encodeJSONPointerSegment(keys[i]));
  }
  if (!hasOwn(value, 'body'))
    fail('TL0002', "a template rule requires 'body'", rulePath + '/body');
  if (!Array.isArray(value.body))
    fail('TL0002', "'body' must be a segment array", rulePath + '/body');
  if (hasOwn(value, 'mode') && typeof value.mode !== 'string')
    fail('TL0002', "'mode' must be a string", rulePath + '/mode');
  const hasPriority = hasOwn(value, 'priority');
  if (hasPriority) {
    if (typeof value.priority !== 'number' || !Number.isFinite(value.priority))
      fail('TL0002', "'priority' must be a finite JSON number", rulePath + '/priority');
    if (value.priority <= RESERVED_PRIORITY_FLOOR)
      fail('TL0003', `priorities at or below ${RESERVED_PRIORITY_FLOOR} are reserved for the built-in rules`,
        rulePath + '/priority');
  }
  const hasMatch = hasOwn(value, 'match');
  if (hasMatch && typeof value.match !== 'string' && !isJsonObject(value.match))
    fail('TL0002', "'match' must be a JSONPath string or an object", rulePath + '/match');

  return Object.freeze({
    index,
    docPath: rulePath,
    bodyDocPath: rulePath + '/body',
    body: value.body,
    hasMatch,
    match: hasMatch ? value.match : null,
    mode: hasOwn(value, 'mode') ? value.mode : '',
    hasPriority,
    priority: hasPriority ? value.priority : 0,
  });
}

/**
 * Normalize a frozen JTLT template document into a frozen model.
 * @param {any} doc - deeply frozen template document
 * @returns {object} frozen template model
 * @throws {JtltCompileError} on TL0001-TL0003 and TL0006 shape errors
 */
export function normalizeJtltTemplate(doc) {
  let sourceRules;
  let rulesPath;
  let output = 'text';

  if (Array.isArray(doc)) {
    sourceRules = doc;
    rulesPath = '';
  }
  else if (isJsonObject(doc)) {
    const keys = Object.keys(doc);
    for (let i = 0; i < keys.length; i++) {
      if (!ENVELOPE_KEYS.has(keys[i]))
        fail('TL0001', `unknown template member '${keys[i]}'`,
          '/' + encodeJSONPointerSegment(keys[i]));
    }
    if (!hasOwn(doc, '$jtlt'))
      fail('TL0001', "the template envelope requires '$jtlt'", '/$jtlt');
    if (doc.$jtlt !== '0.1')
      fail('TL0006', `unknown JTLT format version ${JSON.stringify(doc.$jtlt)}`, '/$jtlt');
    if (hasOwn(doc, 'output') && !OUTPUT_METHODS.has(doc.output)) {
      fail('TL0001',
        `unknown output method ${JSON.stringify(doc.output)} (supported: "text", "xml")`,
        '/output');
    }
    if (hasOwn(doc, 'output'))
      output = doc.output;
    if (!hasOwn(doc, 'rules'))
      fail('TL0001', "the template envelope requires 'rules'", '/rules');
    if (!Array.isArray(doc.rules))
      fail('TL0001', "'rules' must be an array", '/rules');
    sourceRules = doc.rules;
    rulesPath = '/rules';
  }
  else {
    fail('TL0001', 'a template must be a rule array or a version envelope', '');
  }

  const rules = new Array(sourceRules.length);
  for (let i = 0; i < sourceRules.length; i++)
    rules[i] = normalizeRule(sourceRules[i], i, rulesPath);

  return Object.freeze({
    output,
    rulesPrefix: rulesPath,
    rules: Object.freeze(rules),
  });
}

//#endregion
