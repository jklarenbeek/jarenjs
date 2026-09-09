/** Hand-authored declarations for @jarenjs/db/node (strategy 1). */
import type { Driver } from '@jarenjs/db';

export interface NodeOpenOptions {
  /** The busy timeout in milliseconds. */
  timeout?: number;
  readOnly?: boolean;
  /** How long work waits for an open transaction (`JD0012` after). */
  queueTimeout?: number;
}

/** The `node:sqlite` binding; the builtin loads lazily inside open(). */
export declare function nodeDriver(): Driver;
/** Adapt an already-constructed DatabaseSync-shaped database. `backup`
 * is the online-backup primitive triple (`copy`, `rename`, `remove`);
 * the connection declares the capability exactly when it is given. */
export declare function adaptNodeDatabase(db: unknown, options?: {
  queueTimeout?: number;
  backup?: { copy: Function; rename: Function; remove: Function };
}): unknown;
/** Construct and adapt from a loaded `node:sqlite`-shaped module. */
export declare function fromNodeModule(mod: unknown, path: string, options?: NodeOpenOptions): unknown;

// ————— documents on a filesystem —————

/** A byte source: a path, or anything that yields chunks — a
 * `node:fs` read stream and `process.stdin` both are. Spelled
 * structurally so these declarations need no ambient Node types. */
export type DocumentByteSource = string | AsyncIterable<Uint8Array>;

/** A byte sink: anything with `node:stream`'s callback `write`. */
export interface DocumentByteSink {
  write(chunk: string, callback: (error?: Error | null) => void): unknown;
}

/** The document encodings a file may carry. */
export declare const DOCUMENT_FORMATS: readonly ['json', 'jsonl'];

/** The encoding a path declares by its extension: `.jsonl`/`.ndjson`
 * are line-delimited, everything else is one JSON array. */
export declare function formatOf(file: string): 'json' | 'jsonl';

/** The documents of a top-level JSON array, scanned structurally so the
 * array is never held whole. Refuses a root that is not an array
 * (`JD0024`). */
export declare function readJsonDocuments(
  source: DocumentByteSource,
): AsyncGenerator<unknown>;

/** The documents of a JSONL source, one line at a time. */
export declare function readJsonlDocuments(
  source: DocumentByteSource,
): AsyncGenerator<unknown>;

/** The documents of a file or stream in the named encoding. */
export declare function readDocuments(
  source: DocumentByteSource, format: 'json' | 'jsonl',
): AsyncGenerator<unknown>;

/** A sink that publishes whole or not at all. */
export interface DocumentTarget {
  /** The sibling file being filled, or null for a sink with no file. */
  readonly temporary: string | null;
  write(document: unknown, collection?: string): Promise<void>;
  /** Flush, rename over the target, and answer what was written. */
  commit(): Promise<{ bytes: number; documents: number }>;
  /** Remove the temporary; the target keeps the bytes it had. */
  abort(): Promise<void>;
}

/** Replace a file whole: a sibling temporary is renamed over the target
 * on `commit`, and removed on `abort`, so a failed run leaves the
 * original byte for byte. */
export declare function openAtomicTarget(
  target: string, format: 'json' | 'jsonl' | 'collections',
  options?: { collections?: string[] },
): Promise<DocumentTarget>;

/** Write to an open stream; `abort` cannot take back what has left. */
export declare function openStreamTarget(
  stream: DocumentByteSink, format: 'json' | 'jsonl' | 'collections',
  options?: { collections?: string[] },
): DocumentTarget;

/** Validate everything and write nothing. */
export declare function openNullTarget(): DocumentTarget;

/** Read an explicit collection bundle, materialized under the declared bounds. */
export declare function readCollectionBundle(source: DocumentByteSource,
  bounds: { maxBytes: number | null; maxRows: number | null }): Promise<Record<string, unknown[]>>;
