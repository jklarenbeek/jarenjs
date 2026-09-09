//#region the Markdown emitter
// Render the published, language-neutral type model as prose and tables.
// Schema analysis stays in the model compiler so documentation and type
// declarations describe the same constraints.

import { compileJtltStylesheet } from '@jarenjs/json/jtlt';
import { createTypeTestCompiler } from '@jarenjs/validate/query';

import { compileEmitModel } from './model.js';

/** Match a model node by its `kind` — a schema match, so it survives the
 * location-less dispatch of `$apply` on the current node. */
const isKind = (kind) => ({
  schema: { type: 'object', properties: { kind: { const: kind } }, required: ['kind'] },
});

/** Reference documentation for a type model. */
export const MARKDOWN_STYLESHEET = {
  $jtlt: '0.1',
  output: 'text',
  rules: [
    { match: '$', body: [[{ $apply: ['$.declarations[*]', 'decl'] }]] },

    {
      match: isKind('declaration'), mode: 'decl',
      body: [
        '## ', { $raw: '$.name' }, '\n\n',
        [{ $apply: ['$.doc[*]', 'docline'] }],
        [{ $apply: ['$.type', 'shape'] }],
      ],
    },
    { mode: 'docline', body: [{ $raw: '$' }, '\n\n'] },

    // An object declaration gets a member table; anything else gets a
    // one-line type statement.
    {
      match: isKind('object'), mode: 'shape', priority: 2,
      body: [
        '| Member | Type | Required |\n| --- | --- | --- |\n',
        [{ $apply: ['$.members[*]', 'row'] }],
        '\n',
        [{ $apply: ['$.members[?@.doc[0]]', 'memberdoc'] }],
      ],
    },
    {
      mode: 'shape', priority: 1,
      body: ['Type: `', [{ $apply: ['$', 'type'] }], '`\n\n'],
    },
    {
      mode: 'row',
      body: ['| `', { $raw: '$.name' }, '` | `', [{ $apply: ['$.type', 'type'] }], '` | ',
        [{ $apply: ['$.required', 'yesno'] }], ' |\n'],
    },
    { mode: 'yesno', body: [{ $if: ['$', 'yes', 'no'] }] },
    {
      mode: 'memberdoc',
      body: [
        '**`', { $raw: '$.name' }, '`**\n\n',
        [{ $apply: ['$.doc[*]', 'docline'] }],
      ],
    },

    // --- the same type vocabulary, printed as prose ---------------------
    { match: isKind('primitive'), mode: 'type', body: [{ $raw: '$.primitive' }] },
    { match: isKind('ref'), mode: 'type', body: [{ $raw: '$.ref' }] },
    { match: isKind('unknown'), mode: 'type', body: ['any'] },
    { match: isKind('never'), mode: 'type', body: ['never'] },
    { match: isKind('literal'), mode: 'type', body: [{ $json: '$.value' }] },
    { match: isKind('array'), mode: 'type', body: ['array of ', [{ $apply: ['$.items', 'type'] }]] },
    { match: isKind('record'), mode: 'type', body: ['map of ', [{ $apply: ['$.value', 'type'] }]] },
    { match: isKind('optional'), mode: 'type', body: ['optional ', [{ $apply: ['$.item', 'type'] }]] },
    { match: isKind('object'), mode: 'type', body: ['object'] },
    { match: isKind('tuple'), mode: 'type', body: ['tuple'] },
    {
      match: isKind('union'), mode: 'type',
      body: [[{ $apply: ['$.options[0]', 'type'] }], [{ $apply: ['$.options[1:]', 'or'] }]],
    },
    {
      match: isKind('intersection'), mode: 'type',
      body: [[{ $apply: ['$.parts[0]', 'type'] }], [{ $apply: ['$.parts[1:]', 'and'] }]],
    },
    { mode: 'or', body: [' or ', [{ $apply: ['$', 'type'] }]] },
    { mode: 'and', body: [' and ', [{ $apply: ['$', 'type'] }]] },
  ],
};

const compiled = compileJtltStylesheet(MARKDOWN_STYLESHEET,
  { compileTypeTest: createTypeTestCompiler() });

/**
 * Render a type model as Markdown reference documentation.
 * @param {import('./model.js').EmitModel} model - A type model from {@link compileEmitModel}
 * @returns {string} Markdown
 */
export function renderMarkdown(model) {
  return compiled(model);
}

/**
 * Compile a JSON Schema straight to Markdown reference documentation.
 * @param {object|boolean} schema - The schema to document
 * @param {import('./model.js').EmitModelOptions} [options] - Model options
 * @returns {string} Markdown
 */
export function emitMarkdown(schema, options = {}) {
  return renderMarkdown(compileEmitModel(schema, options));
}

//#endregion
