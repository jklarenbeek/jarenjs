//#region Jaren JTLT writer
// Serializes the tagged segment stream a desugared stylesheet produces
// (see desugar.js for the closed grammar) into the output text. The
// writer is chosen once per compiled template; escaping applies to
// interpolated data only - literal template text is the author's markup
// and passes through raw, exactly as in XSLT and T4.

import { JtltRuntimeError } from './errors.js';

const XML_TEST = /[&<>"']/;
const XML_PATTERN = /[&<>"']/g;

function xmlEntity(c) {
  switch (c) {
    case '&': return '&amp;';
    case '<': return '&lt;';
    case '>': return '&gt;';
    case '"': return '&quot;';
    default: return '&#39;';
  }
}

function escapeXml(s) {
  return XML_TEST.test(s) ? s.replace(XML_PATTERN, xmlEntity) : s;
}

// The text value of one interpolated item: null is empty (text
// serialization, not the $string cast), containers are a template error
// pointing at the segment that produced them.
function stringifyItem(v, docPath) {
  switch (typeof v) {
    case 'string':
      return v;
    case 'number':
      return String(v);
    case 'boolean':
      return v ? 'true' : 'false';
    default:
      if (v === null)
        return '';
      throw new JtltRuntimeError('TL2001',
        `cannot interpolate ${Array.isArray(v) ? 'an array' : 'an object'} into text output; dispatch into it with $apply, or embed it with $json`,
        docPath);
  }
}

// Multi-item payloads (a sequence-valued expression) join with a single
// space, the XSLT value-of separator default.
function pushPayload(pair, parts, escape, asJson) {
  const tag = pair[0];
  const docPath = tag.length > 1 ? tag.slice(1) : '';
  for (let i = 1; i < pair.length; i++) {
    if (i > 1)
      parts.push(' ');
    const s = asJson ? JSON.stringify(pair[i]) : stringifyItem(pair[i], docPath);
    parts.push(escape === null ? s : escape(s));
  }
}

function walk(x, parts, escape) {
  if (!Array.isArray(x)) {
    // every dispatched node fires a rule and every rule body is a
    // segment constructor, so a bare value here is an engine-contract
    // break, never author error
    throw new JtltRuntimeError('TL2002',
      'malformed segment stream (engine contract violation)', '');
  }
  const head = x.length === 0 ? null : x[0];
  if (typeof head === 'string') {
    const kind = head.charCodeAt(0);
    if (kind === 0x72) { // 'r'
      parts.push(x[1]);
      return;
    }
    if (kind === 0x65) { // 'e'
      pushPayload(x, parts, escape, false);
      return;
    }
    if (kind === 0x77) { // 'w'
      pushPayload(x, parts, null, false);
      return;
    }
    if (kind === 0x6A) { // 'j'
      pushPayload(x, parts, escape, true);
      return;
    }
    throw new JtltRuntimeError('TL2002',
      `unknown segment tag ${JSON.stringify(head)}`, '');
  }
  for (let i = 0; i < x.length; i++)
    walk(x[i], parts, escape);
}

/**
 * Create the serializer for one output method.
 * @param {'text' | 'xml'} method - the template's output method
 * @returns {(value: any) => string} segment-stream serializer
 */
export function createWriter(method) {
  const escape = method === 'xml' ? escapeXml : null;
  return (value) => {
    if (value === undefined)
      return '';
    const parts = [];
    walk(value, parts, escape);
    return parts.join('');
  };
}

//#endregion
