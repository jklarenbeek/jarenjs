//@ts-check
/**
 * @file Pure model-shape normalization shared by model consumers.
 */

import { setObjectMember } from './object.js';

/**
 * Copy a model without collection/entity `x-rename` planning hints. A hint
 * directs a rename; it is not part of the resulting database shape.
 * Only an own hint on a declaration is removed: root and nested schema
 * annotations stay intact, as do own names such as `__proto__`.
 *
 * This does not validate or deep-copy the model. Object roots and declared
 * maps are copied in member order; unchanged declarations and nested values
 * remain shared. Non-object roots pass through unchanged.
 * @param {any} model
 * @returns {any}
 */
export function withoutModelRenameHints(model) {
  if (model === null || typeof model !== 'object') return model;
  const out = {};
  for (const key of Object.keys(model)) setObjectMember(out, key, model[key]);
  for (const member of ['collections', 'entities']) {
    const declared = model[member];
    if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) continue;
    const stripped = {};
    for (const name of Object.keys(declared)) {
      const spec = declared[name];
      if (spec !== null && typeof spec === 'object' && !Array.isArray(spec)
        && Object.hasOwn(spec, 'x-rename')) {
        const copy = { ...spec };
        delete copy['x-rename'];
        setObjectMember(stripped, name, copy);
      }
      else {
        setObjectMember(stripped, name, spec);
      }
    }
    out[member] = stripped;
  }
  return out;
}
