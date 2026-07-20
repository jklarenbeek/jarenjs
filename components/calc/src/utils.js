//@ts-check
/**
 * @file Small shared helpers for the calc engine.
 *
 * The content hash is the suite's single fingerprint primitive, so calc
 * re-exports the one implementation from `@jarenjs/core` rather than
 * carrying its own copy: equal content hits the same O(1) fast path
 * (vnode `key`, memo key) everywhere downstream.
 */

export { hashContent } from '@jarenjs/core/string';
