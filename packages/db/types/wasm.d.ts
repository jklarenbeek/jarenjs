/** Hand-authored declarations for @jarenjs/db/wasm (strategy 1). */
import type { Driver } from '@jarenjs/db';

/** A driver over an injected wasm SQLite handle (possibly async). */
export declare function wasmDriver(handle: unknown): Driver;
