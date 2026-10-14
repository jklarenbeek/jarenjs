//@ts-check
/**
 * @file The Gantt `click` interaction statement: which task ids it names,
 * the link it carries and the call it names, read as Mermaid's grammar
 * reads them and nothing more.
 *
 *     click taskA,taskB href "https://example.test/page"
 *     click taskA call report(taskA, "two words")
 *     click taskA href "https://example.test/page" call report()
 *
 * The statement is data. A `call` is recorded as a name and its argument
 * strings; nothing here, and nothing in the layout or the renderer, ever
 * looks that name up or invokes it. The link is kept as written: it is the
 * layout that decides whether a link is safe to draw.
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
      const close = line.indexOf('"', next + 1);
      if (close === -1) return refused('click href has no closing quote');
      href = line.slice(next + 1, close);
      if (href === '') return refused('click href is empty');
      at = close + 1;
    }
    else if (word === 'call' && call === null) {
      const open = line.indexOf('(', next);
      if (open === -1) return refused("click call needs the function's arguments in parentheses");
      const close = line.indexOf(')', open + 1);
      if (close === -1) return refused("click call has no closing ')'");
      const name = line.slice(next, open).trim();
      if (name === '') return refused('click call names no function');
      call = { name, args: splitCallArguments(line.slice(open + 1, close)) };
      at = close + 1;
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
  if (click.call !== null) out += ` call ${click.call.name}(${click.call.args.map(printArgument).join(', ')})`;
  return out;
}
