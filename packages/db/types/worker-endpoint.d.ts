/**
 * The SQLite worker endpoint, for a bundled or compiled application to ship
 * beside itself: import it for its side effect from the module the
 * bundler emits as an extra entrypoint, and name that module's URL with the
 * `endpoint` option of `nodeWorkerDriver` or `nodeWorkerPoolDriver`. Loaded as
 * a worker it serves; imported anywhere else it does nothing.
 */
export {};
