//@ts-check
/** Message ids and parameter vocabularies come from the actual English catalogs. */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Linter } from 'eslint';
const parser = new Linter();
import { compileMessageTemplate } from '@jarenjs/core/message';
import { messagesEn } from '@jarenjs/validate';
import { formsMessagesEn } from '@jarenjs/forms';
import { contractMessagesEn } from '@jarenjs/contract';

/** Derive parameter reads from a render closure, refusing unfamiliar code shapes.
 * This is static JavaScript analysis, not a template parser or code execution. */
function closureParameters(fn) {
  const diagnostics = parser.verify(`const render = ${fn.toString()};`, { languageOptions: { ecmaVersion: 'latest', sourceType: 'module' } });
  if (diagnostics.some((d) => d.fatal)) throw new Error('Cannot parse catalog renderer');
  const source = parser.getSourceCode();
  const init = source.ast.body[0]?.declarations[0]?.init;
  if (!init || !['ArrowFunctionExpression', 'FunctionExpression'].includes(init.type))
    throw new Error('Catalog renderer must be an arrow or function expression');
  const parameter = init.params[0];
  if (!parameter) return [];
  if (parameter.type !== 'Identifier') throw new Error('Catalog renderer parameter must be a named object');
  const names = new Set();
  const visit = (node, parent) => {
    if (node.type === 'Identifier' && node.name === parameter.name) {
      if (parent.type === 'MemberExpression' && parent.object === node) {
        if (!parent.computed) names.add(parent.property.name);
        else if (parent.property.type === 'Literal' && typeof parent.property.value === 'string') names.add(parent.property.value);
        else throw new Error('Catalog renderer uses a dynamic parameter name');
      }
      else if (!(parent.type === 'MemberExpression' && parent.property === node && !parent.computed))
        throw new Error('Catalog renderer uses an opaque parameter expression');
    }
    for (const key of source.visitorKeys[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) { for (const item of child) if (item) visit(item, node); }
      else if (child) visit(child, node);
    }
  };
  visit(init.body, init);
  return [...names].sort();
}

/** Read template placeholders through the shared compiler and closure params through the AST. */
export function catalogParameters(catalog) {
  return Object.fromEntries(Object.entries(catalog).map(([id, value]) => [id,
    typeof value === 'string' ? [...compileMessageTemplate(value).parameters].sort() : closureParameters(value)]));
}

/** Reproducible runtime vocabulary and declaration fragments; no target package runtime edge. */
export function messagePenArtifacts() {
  const catalogs = { validate: messagesEn, forms: formsMessagesEn, contract: contractMessagesEn };
  const parameters = Object.fromEntries(Object.entries(catalogs).map(([scope, catalog]) => [scope, catalogParameters(catalog)]));
  const all = Object.assign({}, ...Object.values(parameters));
  if (Object.keys(all).length !== Object.values(parameters).reduce((sum, map) => sum + Object.keys(map).length, 0))
    throw new Error('English message catalog key spaces overlap');
  const vocabulary = '// Derived from the English catalogs by scripts/generate-message-pen.js.\n'
    + "import { deepFreeze } from '@jarenjs/core/object';\n"
    + '/** Canonical parameter names, grouped by their owning English catalog. */\n'
    + `export const CATALOGS = deepFreeze(${JSON.stringify(parameters, null, 2)});\n`;
  const declarations = '// Derived from the English catalogs by scripts/generate-message-pen.js.\n'
    + 'export interface CatalogIds {\n'
    + Object.entries(parameters).map(([scope, map]) => `  ${scope}: ${Object.keys(map).map((name) => JSON.stringify(name)).join(' | ')};`).join('\n')
    + '\n}\nexport interface MessageParameters {\n'
    + Object.entries(all).map(([id, names]) => `  ${JSON.stringify(id)}: ${names.map((name) => JSON.stringify(name)).join(' | ') || 'never'};`).join('\n')
    + '\n}\n';
  return { vocabulary, declarations };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const root = resolve(import.meta.dirname, '..');
  const out = messagePenArtifacts();
  writeFileSync(resolve(root, 'packages/linq/src/messages/vocabulary.js'), out.vocabulary);
  writeFileSync(resolve(root, 'packages/linq/types/message-vocabulary.d.ts'), out.declarations);
}
