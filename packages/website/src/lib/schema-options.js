//@ts-check
/**
 * The validator options every surface uses when it compiles a schema
 * THIS PROJECT ships — the engine grammars, the chart definition, the
 * app meta-schema.
 *
 * `unknownFormats: 'error'` is the point of the file. `@jarenjs/validate`
 * defaults to `'ignore'`, because the specification requires that an
 * unknown `format` be treated as an annotation rather than an assertion
 * failure, and a library has to be able to compile a stranger's schema.
 * Our own schemas are not a stranger's: a `format` in one of them names a
 * check we intend to happen, so a name with no registered compiler is a
 * missing `addFormats` call, and the alternative to failing is a keyword
 * that silently validates everything. That is how the published grammars
 * came to declare `format: "json-path"` for a long time without anything
 * ever checking one.
 *
 * The line is deliberate and worth keeping: a schema the USER supplied —
 * the validator playground's input, a project file in the studio — keeps
 * the library default, because refusing to compile a stranger's valid
 * schema over a format we happen not to implement would be our problem
 * presented as theirs.
 */

/** Options for compiling a schema this project ships. */
export const OUR_SCHEMA_OPTIONS = Object.freeze({
  skipErrors: false,
  collectErrors: true,
  unknownFormats: /** @type {'error'} */ ('error'),
});
