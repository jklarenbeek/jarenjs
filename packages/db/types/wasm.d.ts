/** Hand-authored declarations for @jarenjs/db/wasm (strategy 1). */
import type { Driver } from '@jarenjs/db';

/** A driver over an injected wasm SQLite handle (possibly async). */
export declare function wasmDriver(handle: unknown): Driver;
/** Adapt an `sqlite3.oo1.DB`-shaped database (a loaded sqlite3 module
 * and one of its database objects) to the raw connection contract. */
export declare function adaptOo1Database(sqlite3: unknown, db: unknown): unknown;
/** Build the injected HANDLE for `wasmDriver` from a loaded sqlite3
 * module: `DbClass` picks the database class (default `sqlite3.oo1.DB`;
 * the SAH-pool util's `OpfsSAHPoolDb` for OPFS persistence). */
export declare function sqlite3Handle(sqlite3: unknown, options?: { DbClass?: unknown }): unknown;
