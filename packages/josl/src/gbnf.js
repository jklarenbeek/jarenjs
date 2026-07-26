//#region GBNF grammar for raw JOSL / TOML text
// A character-level grammar for engines that constrain token sampling
// directly (the llama.cpp family), as opposed to the hosted `json_schema`
// providers the data-model twin in schemas/ serves. The two are answers to
// the same question at different layers: this one constrains the *text* a
// model may emit, so the output is syntactically valid JOSL by
// construction rather than by a post-hoc parse.
//
// A context-free grammar can only carry syntax. Duplicate keys, a header
// that reopens a table, a dotted key that collides with a section — every
// rule that needs to remember what the document already said stays the
// parser's job. Constrained sampling narrows the model to well-formed
// text; it does not make `parseJosl` unnecessary.
//
// The rules follow the TOML 1.0 ABNF closely enough to be read next to it.
// Where JOSL adds a value form (null, bigint, regexp, a `[[]]` root array)
// the extra rule is gated on `mode`.

// One deliberate narrowing: `regexp-body` treats an unescaped '/' as the
// closing delimiter unless it sits inside a character class, so a pattern
// that would need deeper nesting is not expressible here. Constrained
// output is a subset of what the parser accepts, never a superset.

const CORE = [
  ['root', 'expression ( newline expression )*'],
  ['expression', 'ws ( keyval ws | table ws )? comment?'],

  ['ws', 'wschar*'],
  ['wschar', '[ \\t]'],
  ['newline', '"\\r"? "\\n"'],
  ['comment', '"#" non-eol*'],
  ['non-eol', '[\\t\\u0020-\\u007E] | non-ascii'],
  // U+007F and the surrogate block are not scalar values TOML admits
  // anywhere, so no character rule may reach them
  ['non-ascii', '[\\u0080-\\uD7FF\\uE000-\\U0010FFFF]'],

  ['keyval', 'key ws "=" ws val'],
  ['key', 'simple-key ( ws "." ws simple-key )*'],
  ['simple-key', 'quoted-key | unquoted-key'],
  ['unquoted-key', '[A-Za-z0-9_-]+'],
  ['quoted-key', 'basic-string | literal-string'],

  ['string', 'ml-basic-string | basic-string | ml-literal-string | literal-string'],
  ['basic-string', '"\\"" basic-char* "\\""'],
  ['basic-char', 'basic-unescaped | escaped'],
  ['basic-unescaped', '[\\t\\u0020-\\u0021\\u0023-\\u005B\\u005D-\\u007E] | non-ascii'],
  ['escaped', '"\\\\" escape-seq-char'],
  // no "\\/": JSON allows it, TOML does not
  ['escape-seq-char', '[\\"\\\\bfnrt] | "u" unicode-scalar-4 | "U" unicode-scalar-8'],
  // Only escapes that name a Unicode scalar value. Spelling the excluded
  // ranges out in hex digits is what keeps a constrained sampler from
  // being steered into a surrogate or a code point past U+10FFFF.
  ['unicode-scalar-4', '[0-9A-CEFa-cef] HEXDIG HEXDIG HEXDIG | [Dd] [0-7] HEXDIG HEXDIG'],
  ['unicode-scalar-8', '"0000" unicode-scalar-4 | "000" HEXNZ hex4 | "0010" hex4'],
  ['hex4', 'HEXDIG HEXDIG HEXDIG HEXDIG'],
  ['HEXDIG', '[0-9A-Fa-f]'],
  ['HEXNZ', '[1-9A-Fa-f]'],

  ['ml-basic-string', '"\\"\\"\\"" newline? ml-basic-body "\\"\\"\\""'],
  ['ml-basic-body', 'mlb-content* ( mlb-quotes mlb-content+ )* mlb-quotes?'],
  ['mlb-content', 'mlb-char | newline | mlb-escaped-nl'],
  ['mlb-char', 'mlb-unescaped | escaped'],
  ['mlb-quotes', '"\\"" "\\""?'],
  ['mlb-unescaped', '[\\t\\u0020-\\u0021\\u0023-\\u005B\\u005D-\\u007E] | non-ascii'],
  ['mlb-escaped-nl', '"\\\\" ws newline ( wschar | newline )*'],

  ['literal-string', '"\'" literal-char* "\'"'],
  ['literal-char', '[\\t\\u0020-\\u0026\\u0028-\\u007E] | non-ascii'],
  ['ml-literal-string', '"\'\'\'" newline? ml-literal-body "\'\'\'"'],
  ['ml-literal-body', 'mll-content* ( mll-quotes mll-content+ )* mll-quotes?'],
  ['mll-content', 'literal-char | newline'],
  ['mll-quotes', '"\'" "\'"?'],

  ['boolean', '"true" | "false"'],

  ['integer', 'hex-int | oct-int | bin-int | dec-int'],
  ['dec-int', '( "+" | "-" )? unsigned-dec-int'],
  ['unsigned-dec-int', '[1-9] ( digit | "_" digit )+ | digit'],
  ['digit', '[0-9]'],
  ['hex-int', '"0x" HEXDIG ( HEXDIG | "_" HEXDIG )*'],
  ['oct-int', '"0o" [0-7] ( [0-7] | "_" [0-7] )*'],
  ['bin-int', '"0b" [01] ( [01] | "_" [01] )*'],

  ['float', 'dec-int ( exp | frac exp? ) | special-float'],
  ['frac', '"." zero-prefixable-int'],
  ['zero-prefixable-int', 'digit ( digit | "_" digit )*'],
  ['exp', '( "e" | "E" ) ( "+" | "-" )? zero-prefixable-int'],
  ['special-float', '( "+" | "-" )? ( "inf" | "nan" )'],

  ['date-time', 'offset-date-time | local-date-time | local-date | local-time'],
  ['date-fullyear', 'digit digit digit digit'],
  ['date-month', 'digit digit'],
  ['date-mday', 'digit digit'],
  ['time-delim', '"T" | "t" | " "'],
  ['time-hour', 'digit digit'],
  ['time-minute', 'digit digit'],
  ['time-second', 'digit digit'],
  ['time-secfrac', '"." digit+'],
  ['time-numoffset', '( "+" | "-" ) time-hour ":" time-minute'],
  ['time-offset', '"Z" | "z" | time-numoffset'],
  ['partial-time', 'time-hour ":" time-minute ":" time-second time-secfrac?'],
  ['full-date', 'date-fullyear "-" date-month "-" date-mday'],
  ['full-time', 'partial-time time-offset'],
  ['offset-date-time', 'full-date time-delim full-time'],
  ['local-date-time', 'full-date time-delim partial-time'],
  ['local-date', 'full-date'],
  ['local-time', 'partial-time'],

  ['array', '"[" array-values? ws-comment-newline "]"'],
  ['array-values',
    'ws-comment-newline val ws-comment-newline "," array-values'
    + ' | ws-comment-newline val ws-comment-newline ","?'],
  ['ws-comment-newline', '( wschar | comment? newline )*'],

  ['inline-table', '"{" ws inline-table-keyvals? ws "}"'],
  ['inline-table-keyvals', 'keyval ( ws "," ws keyval )*'],

  ['std-table', '"[" ws key ws "]"'],
  ['array-table', '"[[" ws key ws "]]"'],
];

// Value alternatives and table forms, in the order a reader should try
// them: the longest, most specific token first.
const VAL_CORE = 'string | boolean | array | inline-table | date-time | float | integer';
const VAL_JOSL = `${VAL_CORE} | null-lit | bigint | regexp`;

const JOSL_ONLY = [
  ['null-lit', '"null"'],
  ['bigint', '( hex-int | oct-int | bin-int | unsigned-dec-int ) "n"'],
  ['regexp', '"/" regexp-body "/" regexp-flags'],
  ['regexp-body', 'regexp-atom+'],
  ['regexp-atom', 'regexp-char | "[" regexp-class-char* "]"'],
  ['regexp-char', '[^/\\\\\\[\\n] | "\\\\" [^\\n]'],
  ['regexp-class-char', '[^\\]\\\\\\n] | "\\\\" [^\\n]'],
  ['regexp-flags', '[a-z]*'],
  ['root-item-table', '"[[" ws "]]"'],
];

/**
 * Build a GBNF grammar for raw JOSL or TOML text.
 *
 * The result is a complete grammar string with `root` as its entry rule,
 * ready to hand to a llama.cpp-family sampler. It constrains syntax only —
 * a document it accepts still has to go through `parseJosl` for the rules
 * a context-free grammar cannot express (duplicate keys, table conflicts).
 * @param {object} [options] - Grammar options
 * @param {'josl'|'toml'} [options.mode] - 'toml' omits the JOSL-only value
 *  forms (null, bigint, regexp) and the `[[]]` root-array header
 * @returns {string} The GBNF grammar
 */
export function toGbnf(options = undefined) {
  const toml = options?.mode === 'toml';
  const rules = [
    ...CORE,
    ['val', toml ? VAL_CORE : VAL_JOSL],
    ['table', toml ? 'array-table | std-table' : 'root-item-table | array-table | std-table'],
    ...(toml ? [] : JOSL_ONLY),
  ];
  const order = new Map(rules.map(([name], i) => [name, i]));
  const header = toml
    ? '# GBNF grammar for TOML 1.0 text (@jarenjs/josl)'
    : '# GBNF grammar for JOSL text (@jarenjs/josl)';
  const body = rules
    .slice()
    .sort((a, b) => order.get(a[0]) - order.get(b[0]))
    .map(([name, def]) => `${name} ::= ${def}`)
    .join('\n');
  return `${header}\n# syntax only; semantic rules stay with the parser\n\n${body}\n`;
}

/**
 * Build a GBNF grammar for strict TOML 1.0 text.
 * @returns {string} The GBNF grammar
 */
export function tomlToGbnf() {
  return toGbnf({ mode: 'toml' });
}

//#endregion
