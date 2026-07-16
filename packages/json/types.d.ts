/**
 * JarenJS JSON - TypeScript Type Definitions
 * JSON addressing standards: validation helpers, JSON Pointer (RFC 6901)
 * and JSONPath (RFC 9535)
 */

// =============================================================================
// Basic Module - JSON validation helpers (basic.js)
// =============================================================================

export function isValidJSONCheap(data: string): boolean;
export function isValidJSON(data: string): boolean;
export function isValidJSONPointer(str: string): boolean;
export function isValidJSONPointerUriFragment(str: string): boolean;
export function isValidRelativeJSONPointer(str: string): boolean;
export function isValidJSONPath(str: string): boolean;

// =============================================================================
// Pointer Module - JSON Pointer RFC 6901 (pointer.js)
// =============================================================================

/**
 * Sentinel for the absence of a value, as distinct from the JSON value
 * `null`. Identical to `JSONPATH_NOTHING`.
 */
export const JSONPOINTER_NOTHING: unique symbol;

export class JSONPointerSyntaxError extends SyntaxError {
  constructor(message: string, source: string, position: number);
  source: string;
  position: number;
}

/** Parsed relative JSON Pointer */
export interface RelativeJsonPointer {
  levels: number;
  hash: boolean;
  segments: string[];
}

/** Compiled JSON Pointer: returns the addressed value or JSONPOINTER_NOTHING */
export type JsonPointerGetter = (root: any) => any;

/** Compiled relative JSON Pointer / data ref: resolves against the RFC 6901 location `dataPath` in `dataRoot` */
export type RelativeJsonPointerResolver = (dataRoot: any, dataPath: string) => any;

/** Parse a JSON Pointer strictly per RFC 6901 into its decoded segments */
export function parseJSONPointer(pointer: string): string[];

/** Parse a relative JSON Pointer strictly (`<non-negative-integer>("#"|<json-pointer>)`) */
export function parseRelativeJSONPointer(pointer: string): RelativeJsonPointer;

/** Compile a JSON Pointer into a specialized zero-allocation getter */
export function compileJSONPointer(pointer: string): JsonPointerGetter;

/** Compile a relative JSON Pointer into a specialized resolver */
export function compileRelativeJSONPointer(pointer: string): RelativeJsonPointerResolver;

/** Compile a data reference (`''`, JSON Pointer or relative JSON Pointer) into a resolver */
export function compileDataRef(ref: string): RelativeJsonPointerResolver;

// =============================================================================
// Path Module - JSONPath RFC 9535 (path.js)
// =============================================================================

export const JSONPATH_NOTHING: unique symbol;

export class JSONPathSyntaxError extends SyntaxError {
  constructor(message: string, source: string, position: number);
  source: string;
  position: number;
}

export interface JSONPathNameSelector {
  readonly kind: 'name';
  readonly name: string;
}

export interface JSONPathWildcardSelector {
  readonly kind: 'wildcard';
}

export interface JSONPathIndexSelector {
  readonly kind: 'index';
  readonly index: number;
}

export interface JSONPathSliceSelector {
  readonly kind: 'slice';
  readonly start: number | null;
  readonly end: number | null;
  readonly step: number | null;
}

export interface JSONPathFilterSelector {
  readonly kind: 'filter';
  readonly expr: object;
}

export type JSONPathSelector =
  | JSONPathNameSelector
  | JSONPathWildcardSelector
  | JSONPathIndexSelector
  | JSONPathSliceSelector
  | JSONPathFilterSelector;

export interface JSONPathSegment {
  readonly descendant: boolean;
  readonly selectors: readonly JSONPathSelector[];
}

export interface JSONPathAst {
  readonly relative: boolean;
  readonly segments: readonly JSONPathSegment[];
}

export interface JSONPathNode {
  path: string;
  value: any;
}

export interface JSONPathQuery {
  (data: any): any[];
  values(data: any): any[];
  first(data: any): any;
  exists(data: any): boolean;
  nodes(data: any): JSONPathNode[];
  paths(data: any): string[];
  readonly source: string;
  readonly ast: JSONPathAst;
}

export function parseJSONPath(source: string): JSONPathAst;
export function compileJSONPath(source: string): JSONPathQuery;
export function queryJSONPath(source: string, data: any): any[];
export function isValidJSONPathStrict(str: string): boolean;
