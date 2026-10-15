//@ts-check
/**
 * @file The `click` interaction statement: which ids it names, the link it
 * carries and the call it names, read as Mermaid's grammars read them and
 * nothing more. Gantt has one grammar:
 *
 *     click taskA,taskB href "https://example.test/page"
 *     click taskA call report(taskA, "two words")
 *     click taskA href "https://example.test/page" call report()
 *
 * A flowchart and a class diagram share another, which carries one action and
 * the author's tooltip text, and a link's target (the bare forms are the
 * flowchart's alone):
 *
 *     click A href "https://example.test/page" "The tooltip" _blank
 *     click A call report(A) "The tooltip"
 *     click A "https://example.test/page" "The tooltip"
 *     click A report "The tooltip"
 *
 * The statement is data. A `call` is recorded as a name and its argument
 * strings; nothing here, and nothing in the layout or the renderer, ever
 * looks that name up or invokes it. The link is kept as written: it is the
 * layout that decides whether a link is safe to draw. A tooltip is text, and
 * it reaches the page only as text.
 *
 * The scan is a single left-to-right pass with no backtracking, so a
 * hostile line costs time linear in its length.
 */

/** @typedef {{ name: string, args: string[] }} ClickCall */
/**
 * @typedef {object} ClickRead
 * @property {{ ids: string[], href: string | null, call: ClickCall | null } | null} value
 *   the statement, or `null` when the text is not a well-formed one
 * @property {string} error why `value` is `null`
 */

/**
 * @typedef {{ ids: string[], href: string | null, target: string | null, call: ClickCall | null,
 *   tooltip: string | null }} NodeClick
 */

/** The link targets Mermaid's flowchart and class lexers name. */
const TARGETS = new Set(['_self', '_blank', '_parent', '_top']);

/** `click` followed by a space or the end of the line, in any case as Mermaid's lexer reads it. */
const CLICK_LINE = /^click(?:\s|$)/i;

const WHITESPACE = /\s/;

/**
 * Whether a trimmed gantt line starts a click statement.
 * @param {string} line
 * @returns {boolean}
 */
export function startsClick(line) {
  return CLICK_LINE.test(line);
}

/**
 * @param {string} text
 * @param {number} at
 * @returns {number} the first index at or after `at` that is not whitespace
 */
function skipSpace(text, at) {
  while (at < text.length && WHITESPACE.test(text[at])) at++;
  return at;
}

/**
 * @param {string} text
 * @param {number} at
 * @returns {number} the end of the run of non-whitespace starting at `at`
 */
function skipWord(text, at) {
  while (at < text.length && !WHITESPACE.test(text[at])) at++;
  return at;
}

/**
 * @param {string} error
 * @returns {ClickRead}
 */
function refused(error) {
  return { value: null, error };
}

/**
 * Whether a line carries the `:` that separates a task's name from its data:
 * a colon outside every double-quoted run and every parenthesis. Such a line
 * is a task row, whatever its first words are, and a URL or an argument
 * holding a colon is not one.
 * @param {string} line
 * @returns {boolean}
 */
export function hasTaskSeparator(line) {
  let quoted = false;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (ch === '(') depth++;
    else if (ch === ')') { if (depth > 0) depth--; }
    else if (ch === ':' && depth === 0) return true;
  }
  return false;
}

/**
 * Read one click statement.
 * @param {string} line - a trimmed line for which {@link startsClick} holds
 * @returns {ClickRead}
 */
export function readClick(line) {
  const idsAt = skipSpace(line, 'click'.length);
  const idsEnd = skipWord(line, idsAt);
  const ids = line.slice(idsAt, idsEnd).split(',').filter((id) => id !== '');
  const kindAt = skipSpace(line, idsEnd);

  if (ids.length === 0) return refused('click names no task id');

  /** @type {string | null} */
  let href = null;
  /** @type {ClickCall | null} */
  let call = null;
  let at = kindAt;
  for (;;) {
    at = skipSpace(line, at);
    if (at >= line.length || line[at] === '%') break;
    const end = skipWord(line, at);
    const word = line.slice(at, end).toLowerCase();
    const next = skipSpace(line, end);
    if (word === 'href' && href === null) {
      if (line[next] !== '"') return refused('click href must be followed by a double-quoted URL');
      const url = readQuoted(line, next);
      if (url === null) return refused('click href has no closing quote');
      if (url.text === '') return refused('click href is empty');
      href = url.text;
      at = url.end;
    }
    else if (word === 'call' && call === null) {
      const read = readCall(line, next);
      if (typeof read === 'string') return refused(read);
      call = read.call;
      at = read.end;
    }
    else {
      return refused(`click statement does not expect '${line.slice(at, end)}'`
        + ' here: it is click <ids> href "<url>" and/or call <name>(<arguments>)');
    }
  }
  if (href === null && call === null) {
    return refused('click statement needs href "<url>" or call <name>(<arguments>)');
  }
  return { value: { ids, href, call }, error: '' };
}

/**
 * The argument strings of a `call`, as Mermaid splits them: on every comma
 * that has an even number of double quotes after it, each piece trimmed and
 * one pair of surrounding quotes removed.
 * @param {string} text - the text between the parentheses
 * @returns {string[]}
 */
export function splitCallArguments(text) {
  if (text.trim() === '') return [];
  let quotes = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === '"') quotes++;
  const out = [];
  let seen = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') seen++;
    else if (text[i] === ',' && (quotes - seen) % 2 === 0) {
      out.push(unquote(text.slice(from, i)));
      from = i + 1;
    }
  }
  out.push(unquote(text.slice(from)));
  return out;
}

/**
 * @param {string} piece
 * @returns {string}
 */
function unquote(piece) {
  const item = piece.trim();
  if (item.startsWith('"') && item.endsWith('"')) return item.length < 2 ? '' : item.slice(1, -1);
  return item;
}

/**
 * One call argument as `splitCallArguments` reads it back: an empty
 * argument, one holding a comma, and one with whitespace at an edge are
 * quoted, which is only possible when the text holds no quote of its own.
 * @param {string} arg
 * @returns {string}
 */
function printArgument(arg) {
  if (arg.includes('"')) return arg;
  return arg === '' || arg.includes(',') || arg !== arg.trim() ? `"${arg}"` : arg;
}

/**
 * The canonical source line of a click statement.
 * @param {{ ids: string[], href: string | null, call: ClickCall | null }} click
 * @returns {string}
 */
export function printClick(click) {
  let out = `click ${click.ids.join(',')}`;
  if (click.href !== null) out += ` href "${click.href}"`;
  if (click.call !== null) out += ` call ${printCall(click.call)}`;
  return out;
}

/**
 * @param {ClickCall} call
 * @returns {string} `name(arguments)` as {@link readCall} reads it back
 */
function printCall(call) {
  return `${call.name}(${call.args.map(printArgument).join(', ')})`;
}

/**
 * Read `name(arguments)` starting at `at`.
 * @param {string} line
 * @param {number} at
 * @returns {{ call: ClickCall, end: number } | string} the call and the index
 *   after its `)`, or why there is none
 */
function readCall(line, at) {
  const open = line.indexOf('(', at);
  if (open === -1) return "click call needs the function's arguments in parentheses";
  const close = line.indexOf(')', open + 1);
  if (close === -1) return "click call has no closing ')'";
  const name = line.slice(at, open).trim();
  if (name === '') return 'click call names no function';
  return { call: { name, args: splitCallArguments(line.slice(open + 1, close)) }, end: close + 1 };
}

/**
 * The double-quoted run that opens at `at`.
 * @param {string} line
 * @param {number} at
 * @returns {{ text: string, end: number } | null} its text and the index after
 *   its closing quote, or null when no quote opens there or none closes it
 */
function readQuoted(line, at) {
  if (line[at] !== '"') return null;
  const close = line.indexOf('"', at + 1);
  return close === -1 ? null : { text: line.slice(at + 1, close), end: close + 1 };
}

/**
 * Read one flowchart or class-diagram click statement: one action (a link
 * or a call), then the author's tooltip text and, after a link, its target.
 * @param {string} line - a trimmed line for which {@link startsClick} holds
 * @param {boolean} bare - whether the flowchart's bare forms are read: a
 *   quoted URL without `href`, and a callback named without `call`
 * @returns {NodeClick | null} the statement, or null when the line is none of
 *   Mermaid's forms
 */
export function readNodeClick(line, bare) {
  const idsAt = skipSpace(line, 'click'.length);
  const idsEnd = skipWord(line, idsAt);
  const ids = line.slice(idsAt, idsEnd).split(',').filter((id) => id !== '');
  let at = skipSpace(line, idsEnd);
  if (ids.length === 0 || at >= line.length) return null;

  /** @type {string | null} */
  let href = null;
  /** @type {ClickCall | null} */
  let call = null;
  const end = skipWord(line, at);
  const word = line.slice(at, end).toLowerCase();
  if (word === 'href') {
    const url = readQuoted(line, skipSpace(line, end));
    if (url === null || url.text === '') return null;
    href = url.text;
    at = url.end;
  }
  else if (word === 'call') {
    const from = skipSpace(line, end);
    if (line.indexOf('(', from) === -1) {
      // `call name` alone: Mermaid reads the rest of the line as the name
      const nameEnd = skipWord(line, from);
      if (nameEnd === from || skipSpace(line, nameEnd) < line.length) return null;
      call = { name: line.slice(from, nameEnd), args: [] };
      at = nameEnd;
    }
    else {
      const read = readCall(line, from);
      if (typeof read === 'string') return null;
      call = read.call;
      at = read.end;
    }
  }
  else if (!bare) return null;
  else if (line[at] === '"') {
    const url = readQuoted(line, at);
    if (url === null || url.text === '') return null;
    href = url.text;
    at = url.end;
  }
  else {
    const name = line.slice(at, end);
    if (name.includes('"') || name.includes('(')) return null;
    call = { name, args: [] };
    at = end;
  }

  at = skipSpace(line, at);
  /** @type {string | null} */
  let tooltip = null;
  if (line[at] === '"') {
    const text = readQuoted(line, at);
    if (text === null) return null;
    tooltip = text.text;
    at = skipSpace(line, text.end);
  }
  /** @type {string | null} */
  let target = null;
  if (href !== null && at < line.length) {
    const targetEnd = skipWord(line, at);
    target = line.slice(at, targetEnd);
    if (!TARGETS.has(target)) return null;
    at = skipSpace(line, targetEnd);
  }
  return at < line.length ? null : { ids, href, target, call, tooltip };
}

/**
 * The canonical source line of a flowchart or class-diagram click statement:
 * a link always with `href`, a callback always as `call name(arguments)`.
 * @param {NodeClick} click
 * @returns {string}
 */
export function printNodeClick(click) {
  let out = `click ${click.ids.join(',')}`;
  if (click.href !== null) out += ` href "${click.href}"`;
  else if (click.call !== null) out += ` call ${printCall(click.call)}`;
  if (click.tooltip !== null) out += ` "${click.tooltip}"`;
  if (click.target !== null) out += ` ${click.target}`;
  return out;
}
