//@ts-check
/**
 * @file The Mermaid engine's English message catalog: every word the
 * engine adds to what a diagram says — the error card's title and line
 * label, a placeholder's lines, the class and ER titles and relations
 * headings, a Gantt's accessible title and description, the interactive
 * viewer's control names and description — and every parse diagnostic the
 * error card shows, keyed by a stable `mermaid/...` id in the suite's one
 * message grammar (`@jarenjs/core/message`): `{name}` substitutes a
 * parameter, `{{` is a literal brace, and a closure stands where English
 * needs a real plural. A locale pack translates these ids;
 * {@link mermaidText} renders through such a pack, compiled, falling back
 * to this English per id, and {@link mermaidErrorText} renders a
 * `MermaidParseError` (whose `message` is the English) in the reader's
 * language.
 *
 * Deliberately not here: the diagram's own text (labels, titles, ids,
 * dates), Mermaid's keywords and syntax a diagnostic quotes (`end note`,
 * `after <id>`, `href "<url>"`, the dateFormat and axisFormat tokens), the
 * message of an error the core date kernels throw (quoted as a parameter),
 * the tooltips' `from:`/`to:` words and arrow, and the developer-facing
 * refusals of a host that misconfigured a seam.
 */

import { compileMessageCatalog } from '@jarenjs/core/message';

/** @param {number} n @returns {string} the English plural suffix */
const plural = (n) => (n === 1 ? '' : 's');

/**
 * The mermaid English catalog: message id → template or render closure.
 * Frozen; a locale pack supplies the same ids.
 * @type {Readonly<Record<string, string | ((params: any) => string)>>}
 */
export const mermaidMessagesEn = /*#__PURE__*/ Object.freeze({
  // ——— the error card ———
  'mermaid/error/title': 'Mermaid parse error',
  'mermaid/error/line': 'Line {line}: {message}',

  // ——— what the render adds to a diagram ———
  'mermaid/placeholder/type': '{type} diagram',
  'mermaid/placeholder/secondary': 'parsed — not yet laid out in v1',
  'mermaid/placeholder/pie': 'parsed — no pie renderer was injected',
  'mermaid/class/title': 'Class diagram',
  'mermaid/class/relations': 'relations',
  'mermaid/er/title': 'Entity–relationship',
  'mermaid/er/relationships': 'relationships',
  'mermaid/gantt/title': 'Gantt chart',
  'mermaid/gantt/title-named': 'Gantt chart: {title}',
  'mermaid/gantt/empty': 'An empty schedule.',
  'mermaid/gantt/summary': (p) => `${p.count} task${plural(p.count)} from ${p.from} to ${p.to}.`,

  // ——— the interactive viewer ———
  'mermaid/interactive/diagram': 'Diagram. Use plus and minus to zoom, arrow keys to pan, zero to reset.',
  'mermaid/interactive/zoom-in': 'Zoom in',
  'mermaid/interactive/zoom-out': 'Zoom out',
  'mermaid/interactive/reset': 'Reset view',

  // ——— parse diagnostics: any diagram ———
  'mermaid/parse/empty': 'empty diagram',
  'mermaid/parse/unknown-type': 'unknown diagram type \'{keyword}\'',

  // ——— parse diagnostics: flowchart, sequence, state, class, ER ———
  'mermaid/flowchart/stray-end': 'unexpected \'end\' with no open subgraph',
  'mermaid/flowchart/expected-link': 'expected a link after a node, found \'{rest}\'',
  'mermaid/flowchart/expected-node': 'expected a node after a link',
  'mermaid/flowchart/too-many-edges': 'a flowchart holds at most {max} edges',
  'mermaid/flowchart/unterminated-shape': 'unterminated \'{opener}\' shape for node \'{id}\'',
  'mermaid/sequence/outside-block': '\'{word}\' outside a block',
  'mermaid/sequence/stray-end': 'unexpected \'end\'',
  'mermaid/state/transition': '\'{line}\' is no transition: From --> To, with an optional \': label\'',
  'mermaid/state/note': '\'{line}\' is no note: note left of|right of <state> with \': text\' or a block up to \'end note\', or note "text" as <id>',
  'mermaid/state/unclosed-note': 'a note opened here is never closed with \'end note\'',
  'mermaid/class/relation': '\'{line}\' is no relation: From ["cardinality"] <operator> ["cardinality"] To, one per line, with an optional \': label\'',
  'mermaid/er/relationship': '\'{line}\' is no relationship: LEFT <cardinality>--<cardinality> RIGHT : label',

  // ——— parse diagnostics: a Gantt's click statements ———
  'mermaid/click/no-id': 'click names no task id',
  'mermaid/click/href-unquoted': 'click href must be followed by a double-quoted URL',
  'mermaid/click/href-unclosed': 'click href has no closing quote',
  'mermaid/click/href-empty': 'click href is empty',
  'mermaid/click/unexpected': 'click statement does not expect \'{word}\' here: it is click <ids> href "<url>" and/or call <name>(<arguments>)',
  'mermaid/click/nothing': 'click statement needs href "<url>" or call <name>(<arguments>)',
  'mermaid/click/call-no-parens': 'click call needs the function\'s arguments in parentheses',
  'mermaid/click/call-unclosed': 'click call has no closing \')\'',
  'mermaid/click/call-no-name': 'click call names no function',

  // ——— parse diagnostics: a Gantt's header ———
  'mermaid/gantt/date-escape': 'unterminated \'[\' escape in dateFormat \'{pattern}\'',
  'mermaid/gantt/date-hundredths': 'dateFormat token \'{token}\' is not supported: the fraction tokens are tenths (S) and milliseconds (SSS); there is no hundredths field',
  'mermaid/gantt/date-quarter': 'dateFormat token \'{token}\' is not supported: a quarter names three months, not one, and the core parser keeps no quarter field',
  'mermaid/gantt/date-ordinal': 'dateFormat token \'{token}\' is not supported: the ordinal suffix is locale text and this engine ships no ordinal data',
  'mermaid/gantt/date-day-of-year': 'dateFormat token \'{token}\' is not supported: the day of the year is derived from a date, not a field of one',
  'mermaid/gantt/date-week-number': 'dateFormat token \'{token}\' is not supported: a week number names a date only under a week-year rule (which week is the first, which day starts it); the core kernel derives the ISO week from a date and reads none back',
  'mermaid/gantt/date-epoch': 'dateFormat token \'{token}\' must be the whole dateFormat: dayjs reads an epoch only as the entire date, and beside other text it reads nothing',
  'mermaid/gantt/axis-bare-percent': 'axisFormat \'{pattern}\' ends in a bare \'%\'',
  'mermaid/gantt/axis-space-padded': 'axisFormat specifier \'%{spec}\' is not supported: a space-padded day is a token the formatter does not have',
  'mermaid/gantt/axis-locale-date': 'axisFormat specifier \'%{spec}\' is not supported: it expands to %e, which is unsupported',
  'mermaid/gantt/axis-sunday-week': 'axisFormat specifier \'%{spec}\' is not supported: d3 counts weeks from the first Sunday; the core week number is ISO, so the two disagree',
  'mermaid/gantt/axis-monday-week': 'axisFormat specifier \'%{spec}\' is not supported: d3 counts weeks from the first Monday; the core week number is ISO, so the two disagree',
  'mermaid/gantt/axis-sunday-zero': 'axisFormat specifier \'%{spec}\' is not supported: d3 numbers Sunday 0; the core weekday number is ISO, where 1 is Monday',
  'mermaid/gantt/axis-unknown': 'axisFormat specifier \'%{spec}\' is not a d3-time-format directive',
  'mermaid/gantt/tick-interval': 'tickInterval \'{text}\' is not a whole count followed by millisecond, second, minute, hour, day, week or month',
  'mermaid/gantt/weekday': 'weekday \'{text}\' is not a day name (monday … sunday)',
  'mermaid/gantt/weekend': 'weekend \'{text}\' is neither friday nor saturday',
  'mermaid/gantt/inclusive-end-dates': 'inclusiveEndDates takes no argument, and \'{value}\' follows it',
  'mermaid/gantt/needs-names': '{directive} \'{pattern}\' asks for a locale name, so it needs a \'dateNames\' provider (parseMermaid(source, {{ dateNames })); this engine ships no month or weekday names of its own',
  'mermaid/gantt/unreadable-pattern': '{directive} \'{pattern}\' cannot be read: {reason}',
  'mermaid/gantt/excludes': 'excludes \'{term}\' is neither \'weekends\', a weekday name, nor a date in this diagram\'s dateFormat',

  // ——— parse diagnostics: a Gantt's tasks ———
  'mermaid/gantt/duplicate-id': 'task id \'{id}\' is declared twice',
  'mermaid/gantt/too-many-fields': 'task \'{name}\' has {count} fields after its flags; a task is written as [flags,] [id,] [start,] end',
  'mermaid/gantt/empty-id': 'task \'{name}\' has an empty id',
  'mermaid/gantt/no-end': 'task \'{name}\' has no end, duration or \'until\'',
  'mermaid/gantt/cycle': 'task \'{id}\' depends on itself, directly or through a cycle',
  'mermaid/gantt/unknown-reference': 'task \'{id}\' says \'{keyword} {target}\', and no task has that id',
  'mermaid/gantt/bad-start': 'task \'{id}\' starts at \'{start}\', which is neither a date in \'{dateFormat}\' nor \'after <id>\'',
  'mermaid/gantt/no-start': 'task \'{id}\' has no start date and no task before it to follow; Mermaid would start it today, and this engine has no clock',
  'mermaid/gantt/bad-end': 'task \'{id}\' ends at \'{end}\', which is neither a date in \'{dateFormat}\', a duration (3d, 1.5w, 2M), nor \'until <id>\'',
  'mermaid/gantt/never-finishes': 'task \'{id}\' can never finish: \'excludes\' removes every day it would need',
  'mermaid/gantt/ends-before-start': 'task \'{id}\' ends before it starts',
  'mermaid/gantt/empty-task': 'task \'{id}\' is empty; only a milestone has no width',
  'mermaid/gantt/bad-duration': 'task \'{id}\' has an unusable duration: {reason}',
  'mermaid/gantt/past-last-instant': 'task \'{id}\' ends past the last instant a date can hold',
});

/**
 * The English catalog, compiled on first use: the fallback of every id.
 * @type {Readonly<Record<string, (params: object) => string>> | undefined}
 */
let english;

/**
 * A text function over a compiled catalog: `t(id, params)` renders `id`
 * through `catalog` (the output of `compileMessageCatalog` over a locale
 * pack: a record of render functions) and falls back to the English of
 * {@link mermaidMessagesEn} per id — when the catalog lacks the id, or its
 * entry throws or answers something other than a string. With no catalog
 * every id renders its English.
 * @param {Readonly<Record<string, unknown>> | null} [catalog] - a compiled catalog, or none for English
 * @returns {(id: string, params?: Record<string, unknown>) => string}
 */
export function mermaidText(catalog) {
  return function mermaidMessage(id, params = {}) {
    const render = catalog != null && Object.hasOwn(catalog, id) ? catalog[id] : undefined;
    if (typeof render === 'function') {
      try {
        const text = render(params);
        if (typeof text === 'string') return text;
      }
      catch { /* a throwing translation renders the English */ }
    }
    english ??= compileMessageCatalog(mermaidMessagesEn);
    return Object.hasOwn(english, id) ? english[id](params) : id;
  };
}

/** English, for the parsers: the `message` of every diagnostic they raise. */
export const mermaidEnglish = mermaidText();

/**
 * The text of a parse failure in the reader's language: a diagnostic that
 * carries its message id (every `MermaidParseError` the parsers raise)
 * renders through `catalog`, falling back to English per id; any other
 * error, and any error without a catalog, keeps its `message`.
 * @example
 * import { compileMessageCatalog } from '@jarenjs/core/message';
 * try { parseMermaid('flowchart TD\n  A --> '); }
 * catch (err) { mermaidErrorText(err, compileMessageCatalog(nlPack)); }
 * @param {any} err - the thrown error
 * @param {Readonly<Record<string, unknown>> | null} [catalog] - a compiled catalog, or none for English
 * @returns {string}
 */
export function mermaidErrorText(err, catalog) {
  if (catalog != null && err !== null && typeof err === 'object' && typeof err.msgid === 'string')
    return mermaidText(catalog)(err.msgid, err.params ?? {});
  return err && err.message ? String(err.message) : String(err);
}
