/**
 * JarenJS Core - TypeScript Type Definitions
 * Core utility functions for type checking, validation, and data manipulation
 */

// =============================================================================
// Branded Types for Type-Safe Numeric Validation
// =============================================================================

type Int8 = number & { __brand: 'int8' };
type Uint8 = number & { __brand: 'uint8' };
type Int16 = number & { __brand: 'int16' };
type Uint16 = number & { __brand: 'uint16' };
type Int32 = number & { __brand: 'int32' };
type Uint32 = number & { __brand: 'uint32' };
type Int64 = number & { __brand: 'int64' };
type Uint64 = number & { __brand: 'uint64' };

type Float16 = number & { __brand: 'float16' };
type Float32 = number & { __brand: 'float32' };
type Float64 = number & { __brand: 'float64' };

// =============================================================================
// Type Checking - Main Module (index.js)
// =============================================================================

/** Checks if value is a function */
export function isFn(data: unknown): data is Function;

/** Checks if value is a scalar type (string, number, boolean, integer, bigint) */
export function isScalarType(data: unknown): boolean;

/** Checks if value is a string */
export function isStringType(data: unknown): data is string;

/** Checks if value is a boolean (strict true/false check) */
export function isBooleanType(data: unknown): data is boolean;

/** Checks if value is a number (including NaN and Infinity) */
export function isNumberType(data: unknown): data is number;

/** Checks if value is an integer */
export function isIntegerType(data: unknown): data is number;

/** Checks if value is a bigint */
export function isBigIntType(data: unknown): data is bigint;

// Scalar getters with defaults
export function getStringType(obj: unknown, def?: string): string | undefined;
export function getBooleanType(obj: unknown, def?: boolean): boolean | undefined;
export function getNumberType(obj: unknown, def?: number): number | undefined;
export function getIntegerType(obj: unknown, def?: number): number | undefined;
export function getBigIntType(obj: unknown, def?: bigint): bigint | undefined;

// Null check
export function isNullValue(data: unknown): data is null;

// Object class checks
export function isObjectOfClass<T extends new (...args: any[]) => any>(
  data: unknown,
  type: T
): data is InstanceType<T>;

/** Checks if value is a plain object (Object constructor) */
export function isObjectClass(data: unknown): data is Record<string, unknown>;

/** Checks if value is a Map */
export function isMapClass(data: unknown): data is Map<unknown, unknown>;

/** Checks if value is typeof object but not an Array */
export function isObjectType(data: unknown): boolean;

/** Checks if value is an Array */
export function isArrayClass(data: unknown): data is unknown[];

/** Checks if value is a Set */
export function isSetClass(data: unknown): data is Set<unknown>;

/** TypedArray base class reference */
export const TypedArray: object;

/** Checks if value is a TypedArray (Uint8Array, Float64Array, etc.) */
export function isTypedArray(data: unknown): boolean;

// Object getters
export function getObjectType<T>(obj: T, def?: T): T | undefined;
export function getArrayClass<T>(obj: T, def?: T): T | undefined;

/** Calculates inclusive and exclusive bounds for range validation */
export function getInclusiveExclusiveBounds<T>(
  getType: (value: unknown) => T,
  inclusive: number | string | undefined,
  exclusive: number | string | boolean | undefined
): [T | undefined, T | undefined];

// =============================================================================
// Array Module (array.js)
// =============================================================================

/** Checks if value is an Array, Set, or TypedArray */
export function isArrayish(data: unknown): boolean;

/** Returns unique elements from an array or Set */
export function getUniqueArray<T>(
  arr: T[] | Set<T>,
  def?: T[]
): T[] | undefined;

/** Checks if all array elements are unique */
export function isUniqueArray(arr: unknown[]): boolean;

/** Checks if all values are included in the array */
export function includesAll(arr: unknown[], values: unknown[]): boolean;

// =============================================================================
// BigInt Module (bigint.js)
// =============================================================================

export function isBigIntishType(data: unknown): boolean;
export function getBigIntishType(obj: unknown, def?: bigint): bigint | undefined;
export function BigInt_min(...args: bigint[]): bigint;
export function BigInt_max(...args: bigint[]): bigint;
export function BigInt_MinMax(...args: bigint[]): [bigint, bigint];

// =============================================================================
// Dates Module (dates.js)
// =============================================================================

// Constants
export const CONST_TICKS_SECOND: 1000;
export const CONST_TICKS_HOUR: 3600000;
export const CONST_TICKS_DAY: 86400000;
export const CONST_TIME_INSERTDATE: '1970-01-01T';
export const CONST_DATE_APPENDTIME: 'T00:00:00Z';
export const CONST_RFC3339_DAYS: readonly [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
export const CONST_RFC3339_REGEX_ISDATE: RegExp;
export const CONST_RFC3339_REGEX_ISTIME: RegExp;

// Date type checks
export function isDateType(data: unknown): data is Date;
export function isDateishType(data: unknown): boolean;
export function isLeapYear(year: number): boolean;

// Date validation
export function isDateOnlyInRange(year?: number, month?: number, day?: number): boolean;
export function isDateOnlyRFC3339(str: string): boolean;
export function isTimeOnlyInRange(
  hrs?: number,
  min?: number,
  sec?: number,
  tzh?: number,
  tzm?: number,
  tzSign?: number
): boolean;
export function isTimeOnlyRFC3339(str: string): boolean;
export function isDateTimeRFC3339(str: string): boolean;

// Date getters
export function getDateTypeOfDateOnlyRFC3339(str: string, def?: Date): Date | undefined;
export function getDateTypeOfTimeOnlyRFC3339(str: string, def?: Date): Date | undefined;
export function getDateTypeOfDateTimeRFC3339(str: string, def?: Date): Date | undefined;

// Duration validation (RFC 3339)
export function isValidDuration(str: string): boolean;

// ISO 8601 date-time and time with optional timezone
export function isValidISODateTime(str: string): boolean;
export function isValidISOTime(str: string): boolean;
export function getDateTypeOfISODateTime(str: string, def?: Date): Date | undefined;
export function getDateTypeOfISOTime(str: string, def?: Date): Date | undefined;

// =============================================================================
// Float Module (float.js)
// =============================================================================

// Float16 constants
export const FLOAT16_MAX: 65504.0;
export const FLOAT16_MIN: 0.00006103515625;
export const FLOAT16_EPS: 0.0009765625;
export const FLOAT16_EXBITS: 5;
export const FLOAT16_FRBITS: 10;

// Float32 constants
export const FLOAT32_MAX: 3.4028234663852886e+38;
export const FLOAT32_MIN: 1.1754943508222875e-38;
export const FLOAT32_EPS: 1.1920928955078125e-7;
export const FLOAT32_EXBITS: 8;
export const FLOAT32_FRBITS: 23;

// Float64 constants
export const FLOAT64_MAX: number;
export const FLOAT64_MIN: number;
export const FLOAT64_EPS: number;
export const FLOAT64_EXBITS: 11;
export const FLOAT64_FRBITS: 52;

// Float128 constants (placeholder)
export const FLOAT128_MAX: 0.0;
export const FLOAT128_MIN: 0.0;
export const FLOAT128_EPS: 0.0;
export const FLOAT128_EXBITS: 15;
export const FLOAT128_FRBITS: 112;

// Float validation with branded types
export function isValidFloat16(value: number): value is Float16;
export function getValidFloat16(value: number, defVal?: number): Float16 | number;
export function Float16_increment(value: number): number;
export function Float16_decrement(value: number): number;

export function isValidFloat32(value: number): value is Float32;
export function getValidFloat32(value: number, defVal?: number): Float32 | number;
export function Float32_increment(value: number): number;
export function Float32_decrement(value: number): number;

export function isValidFloat64(value: number): value is Float64;
export function getValidFloat64(value: number, defVal?: number): Float64 | number;
export function Float64_increment(value: number): number;
export function Float64_decrement(value: number): number;

// =============================================================================
// Function Module (function.js)
// =============================================================================

/** Dummy validator that always returns true */
export function trueThat(
  whatever: unknown,
  _path?: string,
  _root?: unknown,
  _key?: string | string[]
): true;

/** Dummy validator that always returns false */
export function falseThat(
  whatever: unknown,
  _path?: string,
  _root?: unknown,
  _key?: string | string[]
): false;

/** Returns the compiled function or a fallback */
export function fallbackFn<T>(
  compiled: T | undefined,
  fallback?: (...args: any[]) => boolean
): (...args: any[]) => boolean;

/** Adds a function or array of functions to an array */
export function addFunctionToArray<T>(
  arr?: T[],
  fn?: Function | Function[]
): T[];

// =============================================================================
// Integer Module (integer.js)
// =============================================================================

// Int8
export const INT8_MIN: -128;
export const INT8_MAX: 127;
export function isValidInt8(value: number): value is Int8;

// UInt8
export const UINT8_MIN: 0;
export const UINT8_MAX: 255;
export function isValidUInt8(value: number): value is Uint8;

// Int16
export const INT16_MIN: -32768;
export const INT16_MAX: 32767;
export function isValidInt16(value: number): value is Int16;

// UInt16
export const UINT16_MIN: 0;
export const UINT16_MAX: 65535;
export function isValidUInt16(value: number): value is Uint16;

// Int32
export const INT32_MIN: number;
export const INT32_MAX: number;
export function isValidInt32(value: number): value is Int32;

// UInt32
export const UINT32_MIN: 0;
export const UINT32_MAX: number;
export function isValidUInt32(value: number): value is Uint32;

// Int64
export const INT64_MIN: number;
export const INT64_MAX: number;
export function isValidInt64(value: number): value is Int64;

// UInt64
export const UINT64_MIN: 0;
export const UINT64_MAX: number;
export function isValidUInt64(value: number): value is Uint64;

// =============================================================================
// Number Module (number.js)
// =============================================================================

export function isBoolishType(data: unknown): boolean;
export function getBoolishType(obj: unknown, def?: boolean): boolean | undefined;
export function isNumbishType(data: unknown): boolean;
export function isIntishType(data: unknown): boolean;
export function getNumbishType(obj: unknown, def?: number): number | undefined;
export function getIntishType(obj: unknown, def?: number): number | undefined;

// =============================================================================
// Object Module (object.js)
// =============================================================================

/** Deep equality check for objects, arrays, maps, sets, typed arrays */
export function equalsDeep(target: unknown, source: unknown): boolean;

/** Structural equality of two JSON values (RFC 9535 §2.3.5.2.2); JSON-only hot-path variant of equalsDeep */
export function equalsJson(a: unknown, b: unknown): boolean;

/** Merge multiple Maps into one */
export function mergeMap<K, V>(map: Map<K, V>, ...iterables: Map<K, V>[]): void;

/** Merge multiple Sets into one */
export function mergeSet<T>(set: Set<T>, ...iterables: Set<T>[]): void;

// =============================================================================
// String Module (string.js)
// =============================================================================

export function isStringEmpty(data: unknown): boolean;
export function isStringWhiteSpace(data: unknown): boolean;
export function isStringUpperCase(str: string): boolean;
export function isStringLowerCase(str: string): boolean;
export function isRegExpType(data: unknown): data is RegExp;
export function isStringRegExp(str: string): boolean;
export function createRegExp(pattern: string | RegExp | null | undefined): RegExp | undefined;
export function getSegmenter(): Intl.Segmenter;
export function isAsciiString(str: string): boolean;
export function getStringLength(str: string, useGrapheme?: boolean): number;

/** Count Unicode code points (surrogate-pair aware) */
export function countCodePoints(str: string): number;

/** Compare two strings by Unicode scalar values instead of UTF-16 code units */
export function compareCodePoints(a: string, b: string): -1 | 0 | 1;

// =============================================================================
// Scan Module (scan.js)
// =============================================================================

export const CC_TAB: 0x09;
export const CC_LF: 0x0A;
export const CC_CR: 0x0D;
export const CC_SPACE: 0x20;
export const CC_BANG: 0x21;
export const CC_DQUOTE: 0x22;
export const CC_DOLLAR: 0x24;
export const CC_AMP: 0x26;
export const CC_SQUOTE: 0x27;
export const CC_LPAREN: 0x28;
export const CC_RPAREN: 0x29;
export const CC_STAR: 0x2A;
export const CC_COMMA: 0x2C;
export const CC_MINUS: 0x2D;
export const CC_DOT: 0x2E;
export const CC_SLASH: 0x2F;
export const CC_0: 0x30;
export const CC_9: 0x39;
export const CC_COLON: 0x3A;
export const CC_LT: 0x3C;
export const CC_EQ: 0x3D;
export const CC_GT: 0x3E;
export const CC_QUESTION: 0x3F;
export const CC_AT: 0x40;
export const CC_LBRACKET: 0x5B;
export const CC_BACKSLASH: 0x5C;
export const CC_RBRACKET: 0x5D;
export const CC_UNDERSCORE: 0x5F;
export const CC_PIPE: 0x7C;

export function isDigitCode(c: number): boolean;
export function isHexDigitCode(c: number): boolean;
export function isWhitespaceCode(c: number): boolean;
export function isAsciiLowerCode(c: number): boolean;
export function isAsciiUpperCode(c: number): boolean;

// =============================================================================
// Text Module - Basic (text/basic.js)
// =============================================================================

export function isValidAlpha(str: string): boolean;
export function isValidAlphaNumeric(str: string): boolean;
export function isValidNumeric(str: string): boolean;
export function isValidHexaDecimal(str: string): boolean;
export function isValidHexColor(str: string): boolean;

// =============================================================================
// Text Module - Email (text/email.js)
// =============================================================================

export function isValidEmail(str: string): boolean;
export function isValidEmailFull(str: string): boolean;
export function isValidIdnEmail(str: string): boolean;

// =============================================================================
// Text Module - Host (text/host.js)
// =============================================================================

export function isValidMACAddr(str: string): boolean;
export function isValidIPv4(str: string): boolean;
export function isValidIPv6(str: string): boolean;
export function isValidHostname(str: string): boolean;
export function isValidIdnHostname(str: string): boolean;
export function isValidUrl(str: string): boolean;
export function isValidUrlFull(str: string): boolean;
export function isValidUri(str: string): boolean;
export function isValidUriFull(str: string): boolean;
export function isValidUriRef(str: string): boolean;
export function isValidUriRefFull(str: string): boolean;
export function isValidUriTemplate(str: string): boolean;
export function isValidIRI(str: string): boolean;
export function isValidIRIRef(str: string): boolean;

// =============================================================================
// Text Module - Identifiers (text/identifiers.js)
// =============================================================================

export function isValidUUID(str: string): boolean;
export function isValidGUID(str: string): boolean;
export function isValidIdentifier(str: string): boolean;
export function isValidHtmlIdentifier(str: string): boolean;
export function isValidCssIdentifier(str: string): boolean;

// =============================================================================
// Text Module - I-Regexp RFC 9485 (text/iregexp.js)
// =============================================================================

/** Translate an I-Regexp to ECMAScript pattern source, or null when invalid */
export function translateIRegexp(pattern: string): string | null;

/** Compile an I-Regexp to a unicode RegExp (anchored when fullMatch), or null when invalid */
export function compileIRegexp(pattern: string, fullMatch?: boolean): RegExp | null;

/** Validates a pattern against the complete I-Regexp grammar */
export function isValidIRegexp(pattern: string): boolean;

// =============================================================================
// Text Module - Base64 (text/base64.js)
// =============================================================================

export function isValidBase64Full(str: string): boolean;
export function isValidBase64Old(str: string): boolean;
export function isValidBase64(str: string): boolean;
export function isValidBase64Fast(str: string): boolean;

// =============================================================================
// Text Module - Misc (text/misc.js)
// =============================================================================

export function isValidISBN10(str: string): boolean;
export function isValidISBN13(str: string): boolean;
export function isValidCountryAlpha2(str: string): boolean;
export function isValidIBAN(str: string): boolean;

// =============================================================================
// Text Module - I18n (text/i18n.js)
// =============================================================================

export function isLatinLowercaseL(code: number): boolean;
export function isGreek(code: number): boolean;
export function isHebrew(code: number): boolean;
export function isHiragana(code: number): boolean;
export function isKatakana(code: number): boolean;
export function isHan(code: number): boolean;
export function isArabicIndicDigit(code: number): boolean;
export function isExtendedArabicIndicDigit(code: number): boolean;
export function isVirama(code: number): boolean;
export function isCombiningMark(code: number): boolean;
export function checkContextualRules(label: string): boolean;
export function checkDigitMixing(codes: number[]): boolean;
export function isValidIdnChar(code: number): boolean;

// =============================================================================
// Text Module - Punycode (text/punycode.js)
// =============================================================================

export const punycodeVersion: '2.1.0';
export function toASCII(input: string): string;
export function toUnicode(input: string): string;
export function encode(input: string): string;
export function decode(input: string): string;

export namespace ucs2 {
  function decode(string: string): number[];
  function encode(codePoints: number[]): string;
}

// =============================================================================
// Math Module
// =============================================================================

// Int32 Math (math/int32.js)
export function addInt32(a: number, b: number): number;
export function subInt32(a: number, b: number): number;
export function mulInt32(a: number, b: number): number;
export function divInt32(a: number, b: number): number;
export function modInt32(a: number, b: number): number;
export function minInt32(a: number, b: number): number;
export function maxInt32(a: number, b: number): number;
export function clampInt32(value: number, min: number, max: number): number;

// Vec2I32 (math/vec2i32.js)
export class Vec2I32 extends Int32Array {
  constructor(x?: number, y?: number);
  get x(): number;
  set x(value: number);
  get y(): number;
  set y(value: number);
  add(other: Vec2I32): Vec2I32;
  sub(other: Vec2I32): Vec2I32;
  mul(other: Vec2I32): Vec2I32;
  div(other: Vec2I32): Vec2I32;
  dot(other: Vec2I32): number;
  length(): number;
  normalize(): Vec2I32;
  clone(): Vec2I32;
}

// Float64 Math (math/float64.js)
export function addFloat64(a: number, b: number): number;
export function subFloat64(a: number, b: number): number;
export function mulFloat64(a: number, b: number): number;
export function divFloat64(a: number, b: number): number;
export function modFloat64(a: number, b: number): number;
export function minFloat64(a: number, b: number): number;
export function maxFloat64(a: number, b: number): number;
export function clampFloat64(value: number, min: number, max: number): number;

// Vec2F64 (math/vec2f64.js)
export class Vec2F64 extends Float64Array {
  constructor(x?: number, y?: number);
  get x(): number;
  set x(value: number);
  get y(): number;
  set y(value: number);
  add(other: Vec2F64): Vec2F64;
  sub(other: Vec2F64): Vec2F64;
  mul(other: Vec2F64): Vec2F64;
  div(other: Vec2F64): Vec2F64;
  dot(other: Vec2F64): number;
  length(): number;
  normalize(): Vec2F64;
  clone(): Vec2F64;
}

// Vec3F64 (math/vec3f64.js)
export class Vec3F64 extends Float64Array {
  constructor(x?: number, y?: number, z?: number);
  get x(): number;
  set x(value: number);
  get y(): number;
  set y(value: number);
  get z(): number;
  set z(value: number);
  add(other: Vec3F64): Vec3F64;
  sub(other: Vec3F64): Vec3F64;
  mul(other: Vec3F64): Vec3F64;
  div(other: Vec3F64): Vec3F64;
  dot(other: Vec3F64): number;
  cross(other: Vec3F64): Vec3F64;
  length(): number;
  normalize(): Vec3F64;
  clone(): Vec3F64;
}
