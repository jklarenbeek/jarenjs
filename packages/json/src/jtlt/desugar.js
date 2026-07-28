//#region Jaren JTLT desugarer
// Compiles the template model down to an ordinary JSLT 0.1 stylesheet.
// Each rule body becomes an array constructor of tagged segment pairs:
//
//   SegTree := Pair | Array<SegTree>
//   Pair    := ['r<docPath?>', text]        raw literal text
//            | ['e<docPath?>', ...values]   interpolated, method-escaped
//            | ['w<docPath?>', ...values]   interpolated, never escaped
//            | ['j<docPath?>', ...values]   JSON.stringify'd, method-escaped
//
// The tag is a compile-time string constant: one kind character followed
// by the segment's docPath in the *template* document, so runtime errors
// point at the author's source. Literal pairs are wrapped in $const and
// allocate nothing per render.
//
// A matchless catch-all rule is appended per mode at the reserved
// priority. It guarantees every dispatched node fires *some* rule, so
// the stream grammar above is closed: data values only ever appear as
// pair payloads, never bare, and `typeof x[0] === 'string'` identifies a
// pair unambiguously.

import { JtltCompileError } from './errors.js';
import { failerFor } from '../errors.js';

const DOLLAR = 0x24;
const BUILTIN_PRIORITY = -1e308;

const fail = failerFor(JtltCompileError);

// Collect every statically declared `$apply` target mode inside a plain
// JSON expression tree. `$apply` mode arguments are literal strings by
// JSLT contract, so this walk cannot under-collect; over-collection
// (e.g. an `$apply` shape quoted inside `$const`) only compiles a spare
// catch-all rule that is never dispatched.
function collectApplyModes(node, modes) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++)
      collectApplyModes(node[i], modes);
    return;
  }
  if (typeof node !== 'object' || node === null)
    return;
  const keys = Object.keys(node);
  for (let i = 0; i < keys.length; i++) {
    const value = node[keys[i]];
    if (keys[i] === '$apply' && Array.isArray(value)
      && value.length === 2 && typeof value[1] === 'string')
      modes.add(value[1]);
    collectApplyModes(value, modes);
  }
}

function desugarSegment(seg, path, modes) {
  if (typeof seg === 'string') {
    if (seg.charCodeAt(0) !== DOLLAR)
      return { $const: ['r', seg] };
    if (seg.charCodeAt(1) === DOLLAR) // '$$x' is the literal text '$x'
      return { $const: ['r', seg.slice(1)] };
    return ['e' + path, seg];
  }
  if (Array.isArray(seg)) {
    const out = new Array(seg.length);
    for (let j = 0; j < seg.length; j++)
      out[j] = desugarSegment(seg[j], path + '/' + j, modes);
    return out;
  }
  if (typeof seg === 'object' && seg !== null) {
    const keys = Object.keys(seg);
    if (keys.length === 1) {
      const key = keys[0];
      if (key === '$raw') {
        collectApplyModes(seg.$raw, modes);
        return ['w' + path, seg.$raw];
      }
      if (key === '$json') {
        collectApplyModes(seg.$json, modes);
        return ['j' + path, seg.$json];
      }
      if (key === '$apply') { // passes through: its output is spliced verbatim
        collectApplyModes(seg, modes);
        return seg;
      }
    }
    let anyDollar = false;
    for (let j = 0; j < keys.length; j++) {
      if (keys[j].charCodeAt(0) === DOLLAR) {
        anyDollar = true;
        break;
      }
    }
    if (!anyDollar) {
      fail('TL0004',
        'a plain object is not a template segment (map constructors cannot be serialized; use an operator phrase, $json, or $apply)',
        path);
    }
    collectApplyModes(seg, modes);
    return ['e' + path, seg];
  }
  fail('TL0004',
    `${seg === null ? 'null' : typeof seg} is not a template segment; write literal text as a string`,
    path);
}

// The built-in rule per mode: containers apply templates to every child
// in document order, atoms interpolate their string value (the XSLT
// built-in template rules, restated for JSON).
function builtinRule(mode) {
  const rule = {
    priority: BUILTIN_PRIORITY,
    body: {
      $if: [
        { $or: [{ '$is-object': '$' }, { '$is-array': '$' }] },
        [{ $apply: '$[*]' }],
        ['e', '$'],
      ],
    },
  };
  if (mode !== '')
    rule.mode = mode;
  return rule;
}

/**
 * Desugar a normalized template model into a JSLT 0.1 stylesheet
 * document. User rules keep their index; built-in rules are appended.
 * @param {object} model - result of normalizeJtltTemplate
 * @returns {object} a JSLT stylesheet envelope
 * @throws {JtltCompileError} on TL0004 segment errors
 */
export function desugarTemplate(model) {
  const modes = new Set(['']);
  const rules = [];
  const templateRules = model.rules;
  for (let i = 0; i < templateRules.length; i++) {
    const rule = templateRules[i];
    modes.add(rule.mode);
    const body = new Array(rule.body.length);
    for (let j = 0; j < rule.body.length; j++)
      body[j] = desugarSegment(rule.body[j], rule.bodyDocPath + '/' + j, modes);
    const out = {};
    if (rule.hasMatch)
      out.match = rule.match;
    if (rule.mode !== '')
      out.mode = rule.mode;
    if (rule.hasPriority)
      out.priority = rule.priority;
    out.body = body;
    rules.push(out);
  }
  for (const mode of modes)
    rules.push(builtinRule(mode));
  return { $jslt: '0.1', rules };
}

//#region docPath remapping

function appendRest(out, tokens, k) {
  return k < tokens.length ? out + '/' + tokens.slice(k).join('/') : out;
}

/**
 * Translate a docPath into the desugared JSLT stylesheet back into the
 * author's template document. Best-effort: paths that cannot be walked
 * (built-in rules, envelope members the template does not have) map to
 * '' - the whole document - and `render.stylesheet` stays available for
 * inspection.
 * @param {object} model - result of normalizeJtltTemplate
 * @param {string} docPath - pointer into the desugared stylesheet
 * @returns {string} pointer into the template document
 */
export function remapDocPath(model, docPath) {
  if (typeof docPath !== 'string' || docPath === '')
    return '';
  const tokens = docPath.split('/');
  if (tokens.length < 3 || tokens[1] !== 'rules')
    return '';
  const index = Number(tokens[2]);
  const rules = model.rules;
  if (!Number.isInteger(index) || index < 0 || index >= rules.length)
    return ''; // a built-in rule: point at the whole document
  const base = model.rulesPrefix + '/' + index;
  if (tokens.length === 3)
    return base;
  if (tokens[3] !== 'body') // match/mode/priority pass through verbatim
    return appendRest(base, tokens, 3);

  let segs = rules[index].body;
  let out = base + '/body';
  let k = 4;
  while (k < tokens.length) {
    const j = Number(tokens[k]);
    if (!Number.isInteger(j) || j < 0 || j >= segs.length)
      return appendRest(out, tokens, k);
    const seg = segs[j];
    out += '/' + j;
    k++;
    if (typeof seg === 'string') {
      // an expression string desugars to a pair; drop the payload index
      if (seg.charCodeAt(0) === DOLLAR && seg.charCodeAt(1) !== DOLLAR
        && k < tokens.length && tokens[k] === '1')
        k++;
      return appendRest(out, tokens, k);
    }
    if (Array.isArray(seg)) { // nested segment list: keep walking
      segs = seg;
      continue;
    }
    if (typeof seg === 'object' && seg !== null) {
      const keys = Object.keys(seg);
      if (keys.length === 1 && (keys[0] === '$raw' || keys[0] === '$json')) {
        if (k < tokens.length && tokens[k] === '1') {
          k++;
          out += '/' + keys[0];
        }
        return appendRest(out, tokens, k);
      }
      if (keys.length === 1 && keys[0] === '$apply') // verbatim
        return appendRest(out, tokens, k);
      if (k < tokens.length && tokens[k] === '1') // pair-wrapped expression
        k++;
      return appendRest(out, tokens, k);
    }
    return appendRest(out, tokens, k);
  }
  return out;
}

//#endregion

//#endregion
