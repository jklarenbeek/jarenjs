//@ts-check
/**
 * @file The formula module's English message catalog: one template per
 * message a `FormulaError` carries, each naming the formula (`{formulaId}`)
 * before what went wrong. A formula error names its sentence as a
 * `messageId` and the values in it as `params`, as a query error does, so
 * `renderQueryMessage(error, pack)` of `@jarenjs/json` renders it in a
 * `@jarenjs/locales` pack's language; a pack mirrors these keys one for one.
 * A query error raised inside a formula keeps its own message, a reference
 * in `query/formula/query`; text another component wrote (a JSON boundary's,
 * a schema compiler's) is a `{detail}` and stays as it came. Every formula
 * error also carries its English as `params.reason`, which a catalog without
 * these keys renders. A reviewed rule plan's refusals and its conflict
 * diagnostic name these messages too, the rule's id as `{formulaId}`.
 */

/**
 * The plain English catalog: message id → template (`{param}`
 * placeholders; `{{` is a literal `{`).
 */
export const formulaMessagesEn = Object.freeze({
  // a query error raised inside the formula, and another component's text
  'query/formula/query': '{formulaId}: {message}',
  'query/formula/detail': '{formulaId}: {detail}',

  // JQ0013: the profile
  'query/formula/profile-json': '{formulaId}: profile must be JSON',
  'query/formula/profile-object': '{formulaId}: profile must be an object',
  'query/formula/profile-version': '{formulaId}: unsupported language version',
  'query/formula/profile-identity': '{formulaId}: {member} must be nonempty and at most 256 characters',
  'query/formula/profile-expression': '{formulaId}: expression is required',
  'query/formula/profile-result-mode': '{formulaId}: unknown result mode',
  'query/formula/profile-bindings': '{formulaId}: bindings must be an object',
  'query/formula/profile-reserved': '{formulaId}: computed/context are reserved bindings',
  'query/formula/profile-helpers': '{formulaId}: helpers must be an array',
  'query/formula/profile-helper': '{formulaId}: unique helper name and version required',
  'query/formula/profile-packs': '{formulaId}: packs must be an array',
  'query/formula/profile-pack': '{formulaId}: unique pack name and version required',

  // JQ0014: the capabilities the host supplies
  'query/formula/helper-missing': '{formulaId}: missing/incompatible pure helper {name}@{version}',
  'query/formula/pack-missing': '{formulaId}: missing/incompatible operator pack {name}@{version}',
  'query/formula/helper-shadows': '{formulaId}: helper {name} has the name of a function of a listed operator pack',
  'query/formula/schema-missing': '{formulaId}: missing/incompatible schema or type-test compiler',
  'query/formula/schema-rejected': '{formulaId}: schema rejected',

  // JQ0015: computed dependencies and batch targets
  'query/formula/computed-unnamed': '{formulaId}: computed references require a named target',
  'query/formula/computed-cycle': '{formulaId}: computed dependency cycle',
  'query/formula/computed-unknown': '{formulaId}: unknown computed target',
  'query/formula/targets-invalid': '{formulaId}: invalid target list',
  'query/formula/target-identity': '{formulaId}: unique target identity and boolean enabled required',
  'query/formula/target-schemas': '{formulaId}: target schemas must be an object of id -> {{version, schema}',
  'query/formula/target-schema-clash': "{formulaId}: two different schemas under one id '{id}'",

  // JQ2009, JQ2013, JQ2014: evaluation
  'query/formula/batch-limit': '{formulaId}: batch row/cell limit exceeded',
  'query/formula/row-identity': '{formulaId}: unique stable row IDs required',
  'query/formula/input-schema': '{formulaId}: input schema failed',
  'query/formula/result-schema': '{formulaId}: result schema failed',
  'query/formula/outcome-invalid': '{formulaId}: invalid tagged outcome',
  'query/formula/parity-expected': '{formulaId}: expected outcome {index} is not JSON',

  // JQ2015: reviewed rule plans (`formulaId` is the rule's id), and a preview's conflict diagnostic
  'query/formula/rule-identity': '{formulaId}: rule identity, targets and writable fields required',
  'query/formula/rule-field-not-writable': '{formulaId}: target field is not writable',
  'query/formula/rule-rows': '{formulaId}: bounded rows and dataset revision required',
  'query/formula/rule-entity-duplicate': '{formulaId}: duplicate entity identity',
  'query/formula/rule-preview-stale': '{formulaId}: stale or modified preview',
  'query/formula/rule-selection-duplicate': '{formulaId}: selection must contain unique change IDs',
  'query/formula/rule-selection-unknown': '{formulaId}: unknown selected change',
  'query/formula/rule-conflict': '{formulaId}: conflicting target values',
});
