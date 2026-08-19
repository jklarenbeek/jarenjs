//@ts-check
/**
 * @file `toMarkdown`: a compiled contract as one reference document —
 * the title and version, an operations table, one section per public
 * operation (its doc, parameters, body, responses, errors) and the types
 * rendered through `@jarenjs/emit`'s Markdown target over the SAME type
 * model the TypeScript projection uses (`contractTypeModel`), so the
 * names a reader meets in the operation sections are the names the
 * `.d.ts` declares. The document shape is a JTLT stylesheet (compiled
 * once at module scope); the JavaScript half derives the rows.
 */

import { isJsonObject } from '@jarenjs/core/object';
import { compileJtltStylesheet } from '@jarenjs/json/jtlt';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { renderMarkdown } from '@jarenjs/emit/markdown';

import { ContractHostError } from '../errors.js';
import { retainedOperations } from './public.js';
import { contractTypeModel } from './typescript.js';

/**
 * @typedef {import('../compile.js').Contract} Contract
 * @typedef {import('../compile.js').CompiledOperation} CompiledOperation
 */

/**
 * @typedef {Object} MarkdownOptions
 * @property {string} [title] - the document title (default: the contract id, or `jaren-contract`)
 */

/** The document shape. */
const MARKDOWN_STYLESHEET = {
  $jtlt: '0.1',
  output: 'text',
  rules: [
    {
      match: '$',
      body: [
        '# ', '$.title', '\n\n',
        { $if: [{ $exists: '$.version' }, { $concat: ['Version `', '$.version', '`'] }, 'Unversioned'] },
        { $if: [{ $exists: '$.compat[*]' }, { $concat: [', compatible with `', { '$string-join': ['$.compat[*]', '`, `'] }, '`'] }, ''] },
        '. Generated from the jaren-contract document by @jarenjs/contract — do not edit; regenerate instead.\n\n',
        '## Operations\n\n',
        '| Operation | Method | Path | Kind | Task | Idempotency |\n| --- | --- | --- | --- | --- | --- |\n',
        [{ $apply: ['$.operations[*]', 'row'] }],
        '\n',
        [{ $apply: ['$.operations[*]', 'section'] }],
        '# Types\n\n',
        '$.types',
      ],
    },
    {
      mode: 'row',
      body: ['| [`', '$.id', '`](#', '$.anchor', ') | `', '$.method', '` | `', '$.path', '` | ', '$.kind', ' | `', '$.task', '` | `', '$.idempotency', '` |\n'],
    },
    {
      mode: 'section',
      body: [
        '## ', '$.id', '\n\n',
        { $if: [{ $exists: '$.doc' }, { $concat: ['$.doc', '\n\n'] }, ''] },
        '`', '$.method', ' ', '$.path', '` — a ', '$.kind', ' operation',
        { $if: ['$.opaque', ' (opaque: the response bytes are not decoded by the contract)', ''] },
        '; task `', '$.task', '`, idempotency `', '$.idempotency', '`, cache `', '$.cache', '`',
        { $if: [{ $exists: '$.revision' }, { $concat: [', revision `', '$.revision', '`'] }, ''] },
        { $if: [{ $exists: '$.retry' }, { $concat: [', retry up to ', '$.retry.max', ' time(s) on `', { '$string-join': ['$.retry.on[*]', '`, `'] }, '`'] }, ''] },
        '.\n\n',
        '### Parameters\n\n',
        {
          $if: [
            { $exists: '$.parameters[*]' },
            { $concat: ['| Name | In | Required | Schema |\n| --- | --- | --- | --- |\n'] },
            'None.\n',
          ],
        },
        [{ $apply: ['$.parameters[*]', 'parameter'] }],
        '\n### Body\n\n',
        { $if: [{ $exists: '$.body' }, { $concat: ['$.body.description', '\n'] }, 'None.\n'] },
        '\n### Responses\n\n',
        '| Status | Description | Schema |\n| --- | --- | --- |\n',
        '| ', '$.success.status', ' | Success | ', '$.success.schema', ' |\n',
        [{ $apply: ['$.errors[*]', 'response'] }],
        '\n### Errors\n\n',
        {
          $if: [
            { $exists: '$.errors[*]' },
            { $concat: ['| Code | Status | Details |\n| --- | --- | --- |\n'] },
            'None declared.\n',
          ],
        },
        [{ $apply: ['$.errors[*]', 'error'] }],
        '\n',
      ],
    },
    { mode: 'parameter', body: ['| `', '$.name', '` | ', '$.in', ' | ', '$.required', ' | ', '$.schema', ' |\n'] },
    { mode: 'response', body: ['| ', '$.status', ' | Declared failure `', '$.code', '` | wire error |\n'] },
    { mode: 'error', body: ['| `', '$.code', '` | ', '$.status', ' | ', '$.details', ' |\n'] },
  ],
};

/** The stylesheet, compiled once. */
const render = compileJtltStylesheet(MARKDOWN_STYLESHEET, { compileTypeTest: createTypeTestCompiler() });

/**
 * A GitHub-style heading anchor of an operation section: lowercase,
 * punctuation dropped — `product.save` → `productsave`.
 * @param {string} id
 * @returns {string}
 */
function anchorOf(id) {
  return id.replace(/[^a-z0-9]/g, '');
}

/**
 * A Markdown link to a declared type's section in the Types part.
 * @param {string} name
 * @returns {string}
 */
function typeLink(name) {
  return `[\`${name}\`](#${name.toLowerCase()})`;
}

/**
 * A short label of a member schema for a table cell: the type (with a
 * format), a `$ref` target, an enum, a constant, or the schema as JSON
 * when it is none of those. Detail lives in the Types section.
 * @param {unknown} schema
 * @returns {string}
 */
function schemaLabel(schema) {
  if (schema === true || schema === undefined) return 'any';
  if (schema === false) return 'never';
  if (!isJsonObject(schema)) return 'any';
  if (typeof schema.$ref === 'string') {
    const ref = schema.$ref;
    const name = ref.startsWith('#/$defs/') ? ref.slice('#/$defs/'.length).split('/')[0] : null;
    return name !== null && name.length > 0 ? typeLink(name) : `\`${ref}\``;
  }
  if (schema.const !== undefined) return `\`${JSON.stringify(schema.const)}\``;
  if (Array.isArray(schema.enum)) return `one of ${schema.enum.map((v) => `\`${JSON.stringify(v)}\``).join(', ')}`;
  const type = Array.isArray(schema.type) ? schema.type.join(' \\| ') : (typeof schema.type === 'string' ? schema.type : null);
  if (type !== null) {
    let label = `\`${type}\``;
    if (type === 'array' && isJsonObject(schema.items)) label += ` of ${schemaLabel(schema.items)}`;
    if (typeof schema.format === 'string') label += ` (${schema.format})`;
    return label;
  }
  return `\`${JSON.stringify(schema)}\``;
}

/**
 * The rows of one operation section.
 * @param {CompiledOperation} op
 * @param {Record<string, any>} row - the type-model row of the operation (names)
 * @returns {Record<string, unknown>}
 */
function operationRows(op, row) {
  const http = op.http;
  /** @type {Record<string, unknown>[]} */
  const parameters = [];
  /** @type {string[]} */
  const bodyMembers = [];
  const transport = op.input === null ? null : op.input.transport;
  const required = op.input !== null && Array.isArray(op.input.effective.required) ? op.input.effective.required : [];
  const members = Object.keys(http.in);
  for (let i = 0; i < members.length; i++) {
    const name = members[i];
    const loc = http.in[name];
    if (loc === 'body') {
      bodyMembers.push(name);
      continue;
    }
    parameters.push({
      name, in: loc, required: loc === 'path' || required.includes(name) ? 'yes' : 'no',
      schema: schemaLabel(/** @type {any} */ (transport).schemas[name]),
    });
  }
  if (op.policy.idempotency !== 'none') {
    parameters.push({
      name: 'Idempotency-Key', in: 'header', required: op.policy.idempotency === 'required' ? 'yes' : 'no',
      schema: '`string` (the caller-generated idempotency key)',
    });
  }
  /** @type {Record<string, unknown>} */
  const out = {
    id: op.id, anchor: anchorOf(op.id), method: http.method, path: http.path, kind: op.kind,
    task: op.policy.task, idempotency: op.policy.idempotency, cache: op.policy.cache, opaque: http.opaque,
  };
  if (op.policy.revision !== null) out.revision = op.policy.revision;
  if (op.policy.retry !== null) out.retry = { max: op.policy.retry.max, on: op.policy.retry.on.slice() };
  if (op.doc !== null) out.doc = op.doc;
  out.parameters = parameters;
  const inputLink = typeof row.input === 'string' && row.input !== 'null' ? typeLink(row.input) : null;
  if (http.body !== null) {
    out.body = { description: `\`${http.media}\` — the \`${http.body}\` member of ${inputLink} is the whole body${required.includes(http.body) ? ' (required)' : ''}.` };
  }
  else if (bodyMembers.length > 0) {
    out.body = {
      description: bodyMembers.length === members.length
        ? `\`${http.media}\` — ${inputLink}.`
        : `\`${http.media}\` — an object of the ${inputLink} members ${bodyMembers.map((m) => `\`${m}\``).join(', ')}.`,
    };
  }
  out.success = {
    status: String(http.status),
    schema: http.opaque ? `\`${http.media}\` bytes` : (http.status === 204 || http.method === 'HEAD' ? 'no body' : typeLink(row.output)),
  };
  /** @type {Record<string, unknown>[]} */
  const errors = [];
  const codes = Object.keys(op.errors);
  for (let i = 0; i < codes.length; i++) {
    const detailsName = row.details[codes[i]];
    errors.push({ code: codes[i], status: String(op.errors[codes[i]].status), details: detailsName === null ? '—' : typeLink(detailsName) });
  }
  out.errors = errors;
  return out;
}

/**
 * Project a compiled contract to Markdown reference documentation.
 * @param {Contract} contract
 * @param {MarkdownOptions} [options]
 * @returns {string} Markdown
 * @throws {ContractHostError} `JC1008` — not a compiled contract, or a malformed option
 * @example
 * writeFileSync('shop.md', toMarkdown(contract, { title: 'Shop API' }));
 */
export function toMarkdown(contract, options = {}) {
  if (!isJsonObject(options)) throw new ContractHostError('JC1008', 'toMarkdown: options must be an object');
  const ops = retainedOperations(contract, undefined, 'toMarkdown');
  if (options.title !== undefined && typeof options.title !== 'string') {
    throw new ContractHostError('JC1008', 'toMarkdown: options.title must be a string');
  }
  const { rows, model } = contractTypeModel(contract, ops, contract.id === null ? 'a jaren-contract document' : `the jaren-contract '${contract.id}'`);
  /** @type {Record<string, unknown>} */
  const input = {
    title: options.title ?? (contract.id === null ? 'jaren-contract' : contract.id),
    compat: contract.compat.slice(),
    operations: ops.map((op, i) => operationRows(op, rows[i])),
    types: renderMarkdown(model),
  };
  if (contract.version !== null) input.version = contract.version;
  return render(input);
}
