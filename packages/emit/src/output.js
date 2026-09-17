//@ts-check
/** File renderers share the same terminal-newline contract as drift checks.
 * @param {string} text @returns {string} */
export function fileOutput(text) { return text.replace(/(?:\r?\n)+$/, '') + '\n'; }
