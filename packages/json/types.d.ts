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

/** Result of resolving a (relative) JSON Pointer against data */
export interface JsonPointerResult {
  value: any;
  found: boolean;
}

/** Parsed relative JSON Pointer */
export interface RelativeJsonPointer {
  levels: number;
  pointer: string;
  hash: boolean;
}

/** Parse a JSON Pointer and return the decoded path segments */
export function parseJsonPointer(pointer: string): string[];

/** Parse a relative JSON Pointer (`<non-negative-integer>("#"|<json-pointer>)`) */
export function parseRelativeJsonPointer(pointer: string): RelativeJsonPointer;

/** Get a value from data using a JSON Pointer path */
export function getValueByJsonPointer(dataRoot: any, dataPath: string, pointer: string): JsonPointerResult;

/** Get a value from data using a relative JSON Pointer */
export function getValueByRelativePointer(dataRoot: any, dataPath: string, relativePointer: string): JsonPointerResult;

/** Resolve a data reference (either JSON Pointer or relative JSON Pointer) */
export function resolveDataRef(dataRoot: any, dataPath: string, ref: string): JsonPointerResult;

/** Get a value from data using a relative JSON Pointer */
export function resolveRelativePointer(dataRoot: any, dataPath: string, relativePointer: string): JsonPointerResult;

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
