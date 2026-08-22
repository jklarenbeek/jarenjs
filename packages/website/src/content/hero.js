//@ts-check
/**
 * The homepage dispatch demo's own content — the two starting inputs and
 * the words around them. The site owns this because the demo is the
 * SITE's argument, not a package's: it exists to show that the operation
 * contract beside it is real.
 *
 * Nothing here describes what a dispatch does. The stages a reader sees
 * are recorded from a real run through the real binding
 * (`boundaries/hero.js`), so the only thing authored is what goes IN.
 */

/**
 * The two starting inputs, both authored against the demo document's
 * `Item` schema: one it accepts, one it cannot. The second is a real
 * violation of three declared constraints (the stock-number pattern, the
 * title's minimum length and the price's exclusive minimum) — what the
 * validator says about it is the validator's to say.
 */
export const HERO_INPUTS = {
  valid: `{
  "sku": "ZZR-4242",
  "title": "Brass sextant, boxed",
  "price": 129.5,
  "tags": ["optics", "salvage"]
}`,
  invalid: `{
  "sku": "zzr-42",
  "title": "",
  "price": -3
}`,
};

/** The copy around the demo. */
export const HERO_DEMO = {
  title: 'A real dispatch, live',
  lead: 'The panel below is not a recording. A $contract document compiles in your browser, an operation dispatches through @jarenjs/contract\'s local binding, and every stage you see is what that run actually produced — the matched operation, the validator\'s verdict, the handler\'s answer, the outcome envelope.',
  caption: 'compiled and dispatched in your tab — no server',
  edit: 'Edit the input and dispatch again: whatever settles is what shows.',
  links: [
    { href: '#/docs?s=site-contract', label: 'How this site runs on a contract' },
    { href: '#/play?engine=contract', label: 'Open the contract engine in Play' },
  ],
};
