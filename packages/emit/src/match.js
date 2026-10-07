//@ts-check
//#region model-node matching
// The rule match both emitters' stylesheets dispatch on: the model's
// vocabulary of `kind`s is the only coupling between the two stages, so
// the TypeScript and Markdown emitters match nodes the same way.

/**
 * Match a model node by its `kind`. A SCHEMA match, not a path match:
 * `$apply` on the current node dispatches location-less, so a path match
 * would silently never fire for a re-dispatched node. Shape is what these
 * rules mean anyway.
 * @param {string} kind - The node kind
 * @returns {{ schema: { type: string, properties: { kind: { const: string } }, required: string[] } }}
 *   The JTLT rule `match`
 */
export const isKind = (kind) => ({
  schema: { type: 'object', properties: { kind: { const: kind } }, required: ['kind'] },
});

//#endregion
