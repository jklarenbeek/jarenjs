//@ts-check
/**
 * @file Reading an index expression back out of the SQL a dialect wrote
 * for it — the inverse of `expressionSql`, and the reason introspection
 * can round-trip one.
 *
 * The grammar is tiny and closed, because the emitter's is: a call is
 * `name(arg, …)`, an argument is another call, a member read, or a
 * literal. What differs between engines is only how a member and a
 * function name are SPELLED, so both pass those two in and share
 * everything else — a second copy of this walk is a second place for
 * the two halves to drift apart.
 */

/**
 * @param {string} sql
 * @param {{ memberOf: (text: string) => (any | null),
 *   nameOf: (text: string) => (string | null),
 *   stringOf: (text: string) => (string | null) }} spelling
 * @returns {any | null} the expression, or `null` for SQL this dialect
 *   did not write
 */
export function readExpression(sql, spelling) {
  const text = String(sql).trim();
  const parsed = parseNode(text, spelling);
  return parsed === null || parsed.rest.trim().length > 0 ? null : parsed.node;
}

/**
 * One node, and whatever follows it.
 * @param {string} text
 * @param {any} spelling
 * @returns {{ node: any, rest: string } | null}
 */
function parseNode(text, spelling) {
  let source = text.trimStart();
  // a parenthesised node: the emitter brackets a member read, and an
  // engine that re-renders adds its own
  if (source.startsWith('(')) {
    const inner = balanced(source);
    if (inner === null) return null;
    const member = spelling.memberOf(inner.body);
    if (member !== null) return { node: member, rest: inner.rest };
    const parsed = parseNode(inner.body, spelling);
    if (parsed !== null && parsed.rest.trim().length === 0)
      return { node: parsed.node, rest: inner.rest };
    return null;
  }
  // a CALL first: a member read and a call both start with an
  // identifier, and only the declared names are calls — trying the
  // member first would swallow the call's own arguments
  const match = /^([A-Za-z_][A-Za-z0-9_.]*)\s*\(/.exec(source);
  const name = match === null ? null : spelling.nameOf(match[1]);
  if (match !== null && name !== null) {
    source = source.slice(match[1].length).trimStart();
    const inner = balanced(source);
    if (inner === null) return null;
    const args = [];
    let body = inner.body.trim();
    while (body.length > 0) {
      const parsed = parseNode(body, spelling);
      if (parsed === null) return null;
      args.push(parsed.node);
      body = parsed.rest.trimStart();
      if (body.startsWith(',')) { body = body.slice(1); continue; }
      if (body.length > 0) return null;
    }
    return { node: { call: name, args }, rest: inner.rest };
  }

  const member = memberPrefix(source, spelling);
  if (member !== null) return member;
  return literalPrefix(source, spelling);
}

/**
 * A member read at the head of `text`, as this dialect spells one.
 * @param {string} text
 * @param {any} spelling
 * @returns {{ node: any, rest: string } | null}
 */
function memberPrefix(text, spelling) {
  // the whole remaining head up to a comma or a closing parenthesis at
  // depth zero: a member read is a self-contained expression
  const head = headOf(text);
  if (head === null) return null;
  const member = spelling.memberOf(head.body);
  return member === null ? null : { node: member, rest: head.rest };
}

/**
 * A literal at the head of `text`.
 * @param {string} text
 * @param {any} spelling
 * @returns {{ node: any, rest: string } | null}
 */
function literalPrefix(text, spelling) {
  const head = headOf(text);
  if (head === null) return null;
  const body = head.body.trim();
  const string = spelling.stringOf(body);
  if (string !== null) return { node: { value: string }, rest: head.rest };
  if (/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(body))
    return { node: { value: Number(body) }, rest: head.rest };
  if (body === 'TRUE' || body === '1') return { node: { value: true }, rest: head.rest };
  if (body === 'FALSE' || body === '0') return { node: { value: false }, rest: head.rest };
  return null;
}

/**
 * The text up to the next comma or unmatched close parenthesis at depth
 * zero, and what follows it.
 * @param {string} text
 * @returns {{ body: string, rest: string } | null}
 */
function headOf(text) {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      i = text.indexOf("'", i + 1);
      if (i < 0) return null;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') {
      if (depth === 0) return { body: text.slice(0, i), rest: text.slice(i) };
      depth -= 1;
    }
    else if (c === ',' && depth === 0) return { body: text.slice(0, i), rest: text.slice(i) };
  }
  return { body: text, rest: '' };
}

/**
 * The body of the parenthesised group `text` opens with, and what
 * follows the close.
 * @param {string} text
 * @returns {{ body: string, rest: string } | null}
 */
function balanced(text) {
  if (!text.startsWith('(')) return null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      i = text.indexOf("'", i + 1);
      if (i < 0) return null;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(1, i), rest: text.slice(i + 1) };
    }
  }
  return null;
}
