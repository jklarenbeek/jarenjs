//@ts-check
/**
 * @file The `@jarenjs/app` binding of a contract (docs/CONTRACT-FORMAT.md
 * §11): `contractAppBinding` generates the state slice, the start/done
 * actions and the slice schema as pure JSON; `createContractEffect`
 * makes the one `contract` effect those actions invoke, over any open
 * client. Neither imports `@jarenjs/app` — the documents cross as JSON
 * and the task-effect factory crosses as a function the host passes in.
 */

export { contractAppBinding } from './binding.js';
export { createContractEffect } from './effect.js';

/**
 * @typedef {import('./binding.js').ContractAppBinding} ContractAppBinding
 * @typedef {import('./binding.js').ContractAppBindingOptions} ContractAppBindingOptions
 * @typedef {import('./binding.js').TaskSlot} TaskSlot
 * @typedef {import('./effect.js').ContractEffect} ContractEffect
 * @typedef {import('./effect.js').ContractEffectOptions} ContractEffectOptions
 * @typedef {import('./effect.js').ClientLike} ClientLike
 */
