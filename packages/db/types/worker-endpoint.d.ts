/**
 * The SQLite worker endpoint, for a bundled or compiled application to ship
 * beside itself: import it for its side effect from the module the
 * bundler emits as an extra entrypoint, and name that module's URL with the
 * `endpoint` option of `nodeWorkerDriver` or `nodeWorkerPoolDriver`. It serves a
 * worker its driver started (the driver marks the worker's data); imported
 * anywhere else — the main thread, another library's worker thread — it does
 * nothing.
 */
export {};
