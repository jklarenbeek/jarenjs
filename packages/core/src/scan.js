//@ts-check

// Scanner primitives shared by the char-code-level recursive-descent
// parsers (JSONPath in json/path.js, I-Regexp in text/iregexp.js).
// Constants and pure predicates only — stateful token readers belong
// to the parser that owns the cursor.

//#region char codes

export const CC_TAB = 0x09;
export const CC_LF = 0x0A;
export const CC_CR = 0x0D;
export const CC_SPACE = 0x20;
export const CC_BANG = 0x21;
export const CC_DQUOTE = 0x22;
export const CC_HASH = 0x23;
export const CC_DOLLAR = 0x24;
export const CC_PERCENT = 0x25;
export const CC_AMP = 0x26;
export const CC_SQUOTE = 0x27;
export const CC_LPAREN = 0x28;
export const CC_RPAREN = 0x29;
export const CC_STAR = 0x2A;
export const CC_COMMA = 0x2C;
export const CC_MINUS = 0x2D;
export const CC_DOT = 0x2E;
export const CC_SLASH = 0x2F;
export const CC_0 = 0x30;
export const CC_1 = 0x31;
export const CC_9 = 0x39;
export const CC_COLON = 0x3A;
export const CC_LT = 0x3C;
export const CC_EQ = 0x3D;
export const CC_GT = 0x3E;
export const CC_QUESTION = 0x3F;
export const CC_AT = 0x40;
export const CC_LBRACKET = 0x5B;
export const CC_BACKSLASH = 0x5C;
export const CC_RBRACKET = 0x5D;
export const CC_UNDERSCORE = 0x5F;
export const CC_PIPE = 0x7C;
export const CC_TILDE = 0x7E;

//#endregion

//#region predicates

/**
 * Checks if a char code is an ASCII digit (0-9).
 * @param {number} c - The char code
 * @returns {boolean}
 */
export function isDigitCode(c) {
  return c >= CC_0 && c <= CC_9;
}

/**
 * Checks if a char code is an ASCII hexadecimal digit (0-9, A-F, a-f).
 * @param {number} c - The char code
 * @returns {boolean}
 */
export function isHexDigitCode(c) {
  return (c >= CC_0 && c <= CC_9)
    || (c >= 0x41 && c <= 0x46) // A-F
    || (c >= 0x61 && c <= 0x66); // a-f
}

/**
 * Checks if a char code is blank space per RFC 9535 (space, tab,
 * line feed or carriage return).
 * @param {number} c - The char code
 * @returns {boolean}
 */
export function isWhitespaceCode(c) {
  return c === CC_SPACE || c === CC_TAB || c === CC_LF || c === CC_CR;
}

/**
 * Checks if a char code is an ASCII lowercase letter (a-z).
 * @param {number} c - The char code
 * @returns {boolean}
 */
export function isAsciiLowerCode(c) {
  return c >= 0x61 && c <= 0x7A;
}

/**
 * Checks if a char code is an ASCII uppercase letter (A-Z).
 * @param {number} c - The char code
 * @returns {boolean}
 */
export function isAsciiUpperCode(c) {
  return c >= 0x41 && c <= 0x5A;
}

//#endregion
