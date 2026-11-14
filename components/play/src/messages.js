//@ts-check
/**
 * @file The playground's English message catalog: every word of chrome
 * the playground shows a reader (pane, option and choice labels, the
 * buttons and their titles, the result panels and their stat cards, the
 * verdict and timing lines, the location phrases, and the refusals the
 * playground itself writes), keyed by a stable `play/...` id in the
 * suite's one message grammar (`@jarenjs/core/message`): `{name}`
 * substitutes a parameter, `{{` is a literal brace, and a closure stands
 * where English needs logic (a real plural). A locale pack translates
 * these ids; {@link playText} renders through such a pack, compiled,
 * falling back to this English per id.
 *
 * Deliberately English, and so not here: engine and format names
 * (JSONPath, JSLT, CSV, TypeScript, …), the engines' one-line `lead`
 * descriptions, the example library, the messages of the compilers the
 * engines call (a library with its own catalog is rendered through it),
 * and the developer-facing refusals of a host that forgot a seam.
 */

import { compileMessageCatalog } from '@jarenjs/core/message';

/** @param {number} n @returns {string} the English plural suffix */
const plural = (n) => (n === 1 ? '' : 's');

/**
 * The playground's English catalog: message id → template or render
 * closure. Frozen; a locale pack supplies the same ids.
 * @type {Readonly<Record<string, string | ((params: any) => string)>>}
 */
export const playMessagesEn = Object.freeze({
  // ——— the session bar ———
  'play/action/new': 'New',
  'play/action/save': 'Save',
  'play/action/save-as': 'Save As',
  'play/action/download': 'Download',
  'play/action/import': 'Import',
  'play/action/share': 'Share',
  'play/action/delete': 'Delete',
  'play/action/load': 'Load…',
  'play/action/back': '← Back to the result',
  'play/title/save': 'Save this session under the name above',
  'play/title/overwrite': 'Overwrite “{name}”',
  'play/title/save-as': 'Save the name above as a SEPARATE session, keeping the original',
  'play/title/download': 'Download this session as a file',
  'play/title/import': 'Open a downloaded session file',
  'play/title/delete': 'delete this saved session',
  'play/session/placeholder': 'name this session…',
  'play/session/name': 'session name',
  'play/session/load': 'load a saved session',
  'play/session/bound': 'Save overwrites “{name}” · Save As keeps both',

  // ——— the layout: the phone pane switcher, the rail, the stage ———
  'play/layout/panes': 'pane',
  'play/layout/examples': 'Examples',
  'play/layout/editor': 'Editor',
  'play/layout/result': 'Result',
  'play/layout/example-list': 'examples',
  'play/layout/datasets': 'dataset',
  'play/layout/data-view': 'data view',
  'play/layout/form': 'Form',
  'play/layout/resize': 'Resize the editors and result',
  'play/layout/hint': 'Pick an example, or edit the source or data — it runs live.',
  'play/deep/open': 'Explain ▸',
  'play/deep/close': 'Explain ▾',

  // ——— the timing line and the location phrases ———
  'play/timing/compiled': 'compiled {ms}',
  'play/timing/ran': 'ran {ms}',
  'play/timing/validated': 'validated {ms}',
  'play/where/path': 'at {path}',
  'play/where/root': 'at the root',
  'play/where/position': 'at position {position}',
  'play/where/line': 'at line {line}',
  'play/where/line-column': 'at line {line}, column {column}',

  // ——— engines and editor panes ———
  'play/engine/kernels': 'Core kernels',
  'play/pane/selector': 'Selector',
  'play/pane/data': 'Data',
  'play/pane/pointer': 'Pointer',
  'play/pane/location': 'From location (relative pointers)',
  'play/pane/patch': 'Patch',
  'play/pane/target': 'Target document',
  'play/pane/query': 'Query',
  'play/pane/externals': 'Externals',
  'play/pane/stylesheet': 'Stylesheet',
  'play/pane/template': 'Template',
  'play/pane/chain': 'Chain',
  'play/pane/document': 'Document',
  'play/pane/args': 'Arguments — a JSON array',
  'play/pane/schema': 'Schema',
  'play/pane/schemas': 'Referenced schemas',
  'play/pane/contract': '$contract document',
  'play/pane/call': 'Dispatch — {{ "op", "input" }',
  'play/pane/chart': 'Chart definition',

  // ——— option panes and their choices ———
  'play/option/mode': 'Mode',
  'play/option/dialect': 'Dialect',
  'play/option/header-row': 'Header row',
  'play/option/delimiter': 'Delimiter',
  'play/option/typed': 'Typed values',
  'play/option/kernel': 'Kernel',
  'play/option/messages': 'Messages',
  'play/option/target': 'Target',
  'play/option/objects': 'Objects',
  'play/option/normalizer': 'Normalizer',
  'play/option/format': 'Format',
  'play/choice/patch-apply': 'RFC 6902 apply',
  'play/choice/patch-merge': 'RFC 7396 merge',
  'play/choice/patch-diff': 'diff (patch pane = the target)',
  'play/choice/toml-strict': 'TOML (strict 1.0)',
  'play/choice/json-strict': 'JSON (strict)',
  'play/choice/strict': 'strict',
  'play/choice/repair': 'repair',
  'play/choice/yes': 'yes',
  'play/choice/no': 'no',
  'play/choice/auto': 'auto',
  'play/choice/tab': 'tab',
  'play/choice/off': 'off',
  'play/choice/on': 'on',
  'play/choice/open': 'open',
  'play/choice/closed': 'closed',
  'play/choice/none': 'none',
  'play/choice/defaults': 'defaults',
  'play/choice/coercion': 'coercion',
  'play/choice/both': 'both',

  // ——— result panels ———
  'play/panel/output': 'Output',
  'play/panel/preview': 'Preview',
  'play/panel/how-matched': 'How it matched',
  'play/panel/paths': 'The normalized paths',
  'play/panel/how-merged': 'How it merged',
  'play/panel/patch-ops': 'JSON Patch ({count} ops)',
  'play/panel/merge-flavour': 'The merge-patch flavour (RFC 7396)',
  'play/panel/changes': 'What changed',
  'play/panel/how-ran': 'How it ran',
  'play/panel/how-transformed': 'How it transformed',
  'play/panel/compiled-program': 'The compiled program',
  'play/panel/generated-document': 'The generated query document',
  'play/panel/answer': 'Answer — toArray()',
  'play/panel/query-document': 'Query document — toDocument()',
  'play/panel/how-streamed': 'How it streamed ({count})',
  'play/panel/how-streamed-capped': 'How it streamed ({count}, capped)',
  'play/panel/roundtrip': 'The canonical round-trip',
  'play/panel/as-json': 'As JSON',
  'play/panel/kept': 'What JSON keeps',
  'play/panel/how-read': 'How it was read ({count})',
  'play/panel/how-read-capped': 'How it was read ({count}, capped)',
  'play/panel/jsonx-roundtrip': 'The canonical JSONX round-trip',
  'play/panel/summary': 'Summary',
  'play/panel/rows': 'Rows ({count})',
  'play/panel/dialect': 'How it was read',
  'play/panel/repairs': 'The repairs ({count})',
  'play/panel/csv-roundtrip': 'CSV round-trip',
  'play/panel/operator-query': 'The $query operator that runs it',
  'play/panel/operator-agree': 'The operator over the same arguments',
  'play/panel/regexp': 'The ECMAScript RegExp it compiles to',
  'play/panel/verdict': 'Verdict',
  'play/panel/errors': 'Errors ({count})',
  'play/panel/dispatch': 'Dispatch',
  'play/panel/dispatch-echo': 'Dispatch (echo)',
  'play/panel/type-model': 'The type model',

  // ——— table columns and cells ———
  'play/column/type': 'Type',
  'play/column/path': 'Path',
  'play/column/value': 'Value',
  'play/column/property': 'Property',
  'play/column/code': 'Code',
  'play/column/line': 'Line',
  'play/column/col': 'Col',
  'play/column/read': 'What was read',
  'play/column/instance-path': 'path',
  'play/column/message': 'message',
  'play/cell/root': '(root)',

  // ——— stat cards ———
  'play/card/matches': 'Matches',
  'play/card/compile': 'Compile',
  'play/card/run': 'Run',
  'play/card/items': 'Items',
  'play/card/transform': 'Transform',
  'play/card/output': 'Output',
  'play/card/same-input': '=== input',
  'play/card/new-document': 'a new document',
  'play/card/shared': 'shared, copy-on-write',
  'play/card/query-answers': '$query answers',
  'play/card/same-answer': 'Same answer',
  'play/card/refused': 'refused — {message}',

  // ——— results written in words ———
  'play/result/none': '(no result)',
  'play/result/empty': '(empty)',
  'play/result/empty-sequence': '(empty sequence)',
  'play/result/pointer-nothing': '(nothing — the pointer addresses no value)',
  'play/verdict/valid': '✓ valid',
  'play/verdict/errors': (/** @type {{ count: number }} */ p) => `✗ ${p.count} error${plural(p.count)}`,
  'play/note/all-kept': 'every value has a JSON spelling — this is the data any engine\'s data pane reads',
  'play/note/losses': (/** @type {{ count: number }} */ p) => `${p.count} value${plural(p.count)} JSON writes differently:`,
  'play/note/dispatch-hint': 'Type {{ "op": "<operation id>", "input": {{ … } } in the Dispatch pane to run an operation against echo handlers (validateOutput declared \'never\').',
  'play/note/dispatch-call': 'the call must be an object naming an "op" (and optionally an "input")',

  // ——— what JSON writes for a JSONX value ———
  'play/loss/bigint': 'a bigint — JSON has no spelling for it, so JSON.stringify refuses the document',
  'play/loss/regexp': 'a regexp — JSON writes {{}',
  'play/loss/number': '{value} — JSON writes null',
  'play/loss/instant': 'an instant — JSON writes the string {json}',
  'play/loss/local-date-time': 'a local date-time — JSON writes the string {json}',
  'play/loss/local-date': 'a local date — JSON writes the string {json}',
  'play/loss/local-time': 'a local time — JSON writes the string {json}',

  // ——— the CSV summary and dialect table ———
  'play/csv/delimited': '{delimiter}-delimited',
  'play/csv/header': 'header row',
  'play/csv/no-header': 'no header row',
  'play/csv/records': (/** @type {{ count: number }} */ p) => `${p.count} record${plural(p.count)}`,
  'play/csv/repairs': (/** @type {{ count: number }} */ p) => `${p.count} repair${plural(p.count)}`,
  'play/csv/clean': 'clean',
  'play/csv/showing': 'showing the first {count}',
  'play/csv/repair-line': 'line {line}: {code} — {message}',
  'play/csv/delimiter': 'delimiter',
  'play/csv/sniffed': 'sniffed',
  'play/csv/sniff': '{delimiter} · {width} columns · confidence {confidence} · header {headers}',
  'play/csv/record-count': 'records',

  // ——— the kernels engine ———
  'play/kernel/geo-distance': 'geoDistance(a, b) — metres between two [lon, lat] positions',
  'play/kernel/geohash-encode': 'geohashEncode(lon, lat, precision) — the base-32 cell',
  'play/kernel/add-duration': 'addDuration(date, duration) — calendar arithmetic over RFC 3339 text',
  'play/kernel/date-format': 'compileDateFormat(pattern)(date) — an LDML picture over RFC 3339 text',
  'play/kernel/round-exact': 'roundExact(x, precision, mode) — exact decimal rounding, \'half-up\' or \'half-even\'',
  'play/kernel/iregexp': 'compileIRegexp(pattern, true).test(input) — an RFC 9485 I-Regexp matched whole',
  'play/kernel/answers': 'the kernel answers {answer}',
  'play/kernel/answers-nothing': 'the kernel answers nothing',
  'play/kernel/not-compared': 'not compared — {reason}',
  'play/kernel/refuses': 'not compared — $query refuses',
  'play/kernel/refuses-with': 'not compared — $query refuses with {code}',
  'play/kernel/and': '{first} and {second}',
  'play/kernel/query-nothing': '$query nothing',
  'play/kernel/query-answers-nothing': 'not compared — $query answers nothing',
  'play/kernel/same': 'yes',
  'play/kernel/different': 'no',

  // ——— the refusals the playground writes ———
  'play/error/unknown-engine': 'unknown engine: {engine}',
  'play/error/json': '{pane}: {message}',
  'play/error/schemas-array': 'schemas: expected a JSON array of schemas, each with an $id',
  'play/error/schemas-item': 'schemas: item {index} is not a schema object with an $id',
  'play/error/schemas-repeat': 'schemas: item {index} repeats the $id {id}',
  'play/error/args-array': 'args: expected a JSON array of the kernel\'s arguments',
  'play/error/kernel-null': 'argument {index}: {name} answers null for {text}',
  'play/error/kernel-input': 'argument 1: the input a pattern is tested against is a string',
  'play/error/schema-kind': 'schema: expected a JSON Schema, an object or a boolean',
  // the subject a JSON parse failure names, by pane
  'play/subject/data': 'data',
  'play/subject/target': 'target',
  'play/subject/patch': 'patch',
  'play/subject/query': 'query',
  'play/subject/externals': 'externals',
  'play/subject/stylesheet': 'stylesheet',
  'play/subject/template': 'template',
  'play/subject/schema': 'schema',
  'play/subject/schemas': 'schemas',
  'play/subject/args': 'args',
  'play/subject/document': 'document',
  'play/subject/call': 'call',

  // ——— the LINQ chain reader ———
  'play/chain/comment': 'a comment opened here is never closed',
  'play/chain/template-literal': 'a template literal is not read — join text with .concat()',
  'play/chain/character': 'unexpected character {character}',
  'play/chain/escape': 'an unknown escape \\{escape}',
  'play/chain/string': 'a string opened here is never closed',
  'play/chain/operator': 'a callback cannot capture the JavaScript operator {operator} — spell it with {spelling}',
  'play/chain/spell-add': '.add() (or .concat() for text)',
  'play/chain/spell-sub': '.sub() (or .neg())',
  'play/chain/spell-conditional': '.and() and .or()',
  'play/chain/expected': 'expected {expected}, found {found}',
  'play/chain/end': 'the end of the chain',
  'play/chain/paren-after-from': '\'(\' after from',
  'play/chain/paren-after-data': '\')\' after from(data',
  'play/chain/chain-operator': 'a chain operator',
  'play/chain/comma-or-paren': '\',\' or \')\'',
  'play/chain/comma-or-bracket': '\',\' or \']\'',
  'play/chain/comma-or-brace': '\',\' or \'}\'',
  'play/chain/parameter': 'a parameter',
  'play/chain/member-name': 'a member name',
  'play/chain/colon': '\':\' after the member {name}',
  'play/chain/value': 'a value',
  'play/chain/member-or-method': 'a member or method name',
  'play/chain/start': 'a chain starts with from(data) — the Data pane is its source',
  'play/chain/from-data': 'from() reads the Data pane: write from(data)',
  'play/chain/terminal': '{name}() is a terminal: it runs the chain, and this engine shows the chain\'s document beside its toArray() answer — end the chain before {name}()',
  'play/chain/not-operator': '{name} is not a chain operator here ({operators})',
  'play/chain/block': 'a callback body that opens with {{ is a block in JavaScript, not an object — wrap the object in parentheses: (u) => ({{ … })',
  'play/chain/not-value': '\'{name}\' is not a value here — a chain operator takes a callback, a literal or from(data)',
  'play/chain/not-parameter': '\'{name}\' is not a parameter of this callback ({parameters}) — a callback reads only its own parameters',
  'play/chain/no-parameters': 'it has none',
  'play/chain/index': 'an index is written .at(i), and an odd member name .get(\'…\')',
  'play/chain/literal-members': 'a literal has no members here — only a callback\'s parameters are read with "."',
  'play/chain/receives-nothing': '\'{name}\' receives nothing here — this callback is handed fewer arguments',
  'play/chain/method-read': '.{name} is a method: call it, .{name}(…), or read a member of that name with .get(\'{name}\')',
  'play/chain/not-method': '.{name}() is not a method of the expression surface',
});

/** The English catalog, compiled once: the fallback of every id. */
const ENGLISH = compileMessageCatalog(playMessagesEn);

/**
 * A text function over a compiled catalog: `t(id, params)` renders `id`
 * through `catalog` (the output of `compileMessageCatalog` over a locale
 * pack: a record of render functions) and falls back to the English of
 * {@link playMessagesEn} per id — when the catalog lacks the id, or its
 * entry throws or answers something other than a string. With no catalog
 * every id renders its English.
 * @example
 * import { compileMessageCatalog } from '@jarenjs/core/message';
 * const t = playText(compileMessageCatalog({ 'play/action/save': 'Opslaan' }));
 * t('play/action/save');                      // 'Opslaan'
 * t('play/panel/rows', { count: 3 });         // 'Rows (3)', English fallback
 * @param {Readonly<Record<string, unknown>> | null} [catalog] - a compiled catalog, or none for English
 * @returns {(id: string, params?: Record<string, unknown>) => string}
 */
export function playText(catalog) {
  return function playMessage(id, params = {}) {
    const render = catalog != null && Object.hasOwn(catalog, id) ? catalog[id] : undefined;
    if (typeof render === 'function') {
      try {
        const text = render(params);
        if (typeof text === 'string') return text;
      }
      catch { /* a throwing translation renders the English */ }
    }
    return Object.hasOwn(ENGLISH, id) ? ENGLISH[id](params) : id;
  };
}

/** English, for the code paths that run before any catalog is known. */
export const playEnglish = playText();
