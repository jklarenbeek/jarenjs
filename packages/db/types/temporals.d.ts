/** The temporal seam: opaque, recognized by the store. */
export interface StoreTemporals {
  readonly hooks: object;
  readonly calendar: object;
}

/** Enable declared temporal members and the calendar operators `$instant`
 * and `$wall` on a store: pass the answer as
 * `openStore(model, { driver, temporals: storeTemporals() })`. */
export declare function storeTemporals(): StoreTemporals;
