//@ts-check
/**
 * @file `toTypeScript`: a compiled contract as one `.d.ts` — every public
 * operation's input, output and error-details types through
 * `@jarenjs/emit`'s type model (`compileEmitModel` + `renderTypeScript`,
 * the suite's one declaration renderer), then a typed operation map and
 * the client/handler declarations through a JTLT stylesheet
 * (`typescript.jtlt.json`, compiled once at module scope).
 *
 * One emit model covers the whole contract: a synthetic root whose
 * `$defs` holds the operation types first (`<PascalOp>Input`,
 * `<PascalOp>Output`, `<PascalOp><PascalCode>Details`) and the reachable
 * contract `$defs` after them. Emit declares `$defs` first and in
 * document order and names each after its key, so the operation types
 * keep the names this module gives them (a contract `$defs` entry that
 * spells the same name is the one emit suffixes); their `#/$defs/X`
 * references resolve against the same root, so a `Product` referenced
 * from three operations is declared once. The root's own declaration
 * (`unknown`) is not rendered.
 *
 * `Meta`, `WireError`, `Outcome<T>`, `InvokeContext`, `Client`,
 * `Failure`, `HandlerContext` and `Handlers` are fixed text in the
 * stylesheet — the D6 shapes as every binding carries them
 * (`OUTCOME_META_MEMBERS` / `OUTCOME_ERROR_MEMBERS` in the client module
 * are the runtime twins; a test holds the text to them).
 */

import { isJsonObject, setObjectMember } from '@jarenjs/core/object';
import { compileJtltStylesheet } from '@jarenjs/json/jtlt';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { compileEmitModel } from '@jarenjs/emit/model';
import { renderTypeScript } from '@jarenjs/emit/typescript';

import { ContractHostError } from '../errors.js';
import { publicProjection, retainedOperations } from '../public.js';
import TYPESCRIPT_STYLESHEET from './typescript.jtlt.json' with { type: 'json' };

/**
 * @typedef {import('../compile.js').Contract} Contract
 * @typedef {import('../compile.js').CompiledOperation} CompiledOperation
 */

/**
 * @typedef {Object} TypeScriptOptions
 * @property {boolean} [banner=true] - emit the do-not-edit header
 */

/** The stylesheet, compiled once. */
const render = compileJtltStylesheet(TYPESCRIPT_STYLESHEET, { compileTypeTest: createTypeTestCompiler() });

/**
 * PascalCase an operation id or error code: `product.save` → `ProductSave`,
 * `not-found` → `NotFound`. Both grammars are lowercase words joined by
 * `.` or `-`, so the result is always an identifier.
 * @param {string} word
 * @returns {string}
 */
function pascal(word) {
  const parts = word.split(/[.-]/);
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length === 0) continue;
    out += p.charAt(0).toUpperCase() + p.slice(1);
  }
  return out;
}

/**
 * The type model of a contract: the synthetic `$defs` root, the row per
 * operation the stylesheet renders, and the rendered declarations.
 * @param {Contract} contract
 * @param {CompiledOperation[]} ops
 * @param {string} source - what the model records as its source
 * @returns {{ types: string, rows: Record<string, unknown>[], model: import('@jarenjs/emit/model').EmitModel }}
 */
export function contractTypeModel(contract, ops, source) {
  const pub = /** @type {any} */ (publicProjection(contract, { ops: ops.map((o) => o.id) }));
  const contractDefs = isJsonObject(pub.$defs) ? pub.$defs : {};
  /** @type {Set<string>} */
  const taken = new Set(Object.keys(contractDefs));
  /** @param {string} base */
  const unique = (base) => {
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base}${n}`;
    taken.add(name);
    return name;
  };
  /** @type {Record<string, any>} */
  const defs = {};
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const base = pascal(op.id);
    let input = 'null';
    if (op.input !== null) {
      input = unique(`${base}Input`);
      setObjectMember(defs, input, op.input.schema);
    }
    const output = unique(`${base}Output`);
    setObjectMember(defs, output, op.output.schema);
    const codes = Object.keys(op.errors);
    /** @type {Record<string, string | null>} */
    const details = {};
    for (let j = 0; j < codes.length; j++) {
      const decl = op.errors[codes[j]];
      if (decl.schema === null) {
        setObjectMember(details, codes[j], null);
        continue;
      }
      const name = unique(`${base}${pascal(codes[j])}Details`);
      setObjectMember(defs, name, decl.schema);
      setObjectMember(details, codes[j], name);
    }
    rows.push({ id: op.id, kind: op.kind, input, output, errors: codes, details, opaque: op.http.opaque });
  }
  const names = Object.keys(contractDefs);
  for (let i = 0; i < names.length; i++) setObjectMember(defs, names[i], contractDefs[names[i]]);
  const model = compileEmitModel({ $defs: defs }, { name: 'Contract', source });
  const declarations = model.declarations.filter((d) => d.name !== model.root);
  const types = renderTypeScript({ ...model, declarations }, { banner: false });
  return { types, rows, model: { ...model, declarations } };
}

/**
 * Project a compiled contract to TypeScript declarations: the operation
 * types, `Operations`, `UrlOperations`, `Meta`, `WireError`, `Outcome<T>`,
 * `InvokeContext`, `Client`, `Failure`, `HandlerContext`, `Handlers`.
 * @param {Contract} contract
 * @param {TypeScriptOptions} [options]
 * @returns {string} TypeScript source (`.d.ts`)
 * @throws {ContractHostError} `JC1008` — not a compiled contract, or a malformed option
 * @example
 * writeFileSync('shop.d.ts', toTypeScript(contract));
 * // import type { Client, Operations } from './shop.js';
 */
export function toTypeScript(contract, options = {}) {
  if (!isJsonObject(options)) throw new ContractHostError('JC1008', 'toTypeScript: options must be an object');
  const ops = retainedOperations(contract, undefined, 'toTypeScript');
  const banner = options.banner === undefined ? true : options.banner;
  if (typeof banner !== 'boolean') throw new ContractHostError('JC1008', 'toTypeScript: options.banner must be a boolean');
  const source = contract.id === null ? 'a jaren-contract document' : `the jaren-contract '${contract.id}'`;
  const { types, rows } = contractTypeModel(contract, ops, source);
  return render({
    // a newline in the id could end the line comment; the grammar forbids
    // one, the replacement is the belt to that brace
    banner: banner ? `// Generated by @jarenjs/contract from ${source.replace(/[\r\n\u2028\u2029]+/g, ' ')}.\n// Do not edit: regenerate instead.\n\n` : '',
    types,
    operations: rows,
  });
}
