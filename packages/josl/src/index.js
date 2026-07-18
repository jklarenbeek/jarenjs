//#region @jarenjs/josl
// JOSL - JavaScript Obvious Streaming Language. Experimental.
//
// A TOML 1.0 backward-compatible data language with JavaScript's obvious
// value types as first-class citizens (null, bigint, regexp, datetimes)
// plus a streamable root array, and JSONX, the same extensions over JSON.
// See FORMAT.md for the language delta and design rationale.

export { parseJosl, parseToml } from './parse.js';
export { createStreamReader, parseJoslStream } from './stream.js';
export {
  stringifyJosl,
  stringifyToml,
  formatKey,
  formatKeyPath,
  formatValue,
  formatSection,
} from './stringify.js';
export { createStreamWriter, stringifyJoslChunks } from './write.js';
export { parseJsonx, stringifyJsonx } from './jsonx.js';
export { JoslSyntaxError, JoslStringifyError, JsonxSyntaxError } from './errors.js';
export {
  LocalDate,
  LocalTime,
  LocalDateTime,
  isValidDateParts,
  isValidTimeParts,
} from './values.js';

//#endregion
