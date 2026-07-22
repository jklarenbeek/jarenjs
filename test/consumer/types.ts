import { isStringType } from '@jarenjs/core';
import { getStringLength } from '@jarenjs/core/string';
import { compileJsonQuery } from '@jarenjs/json/query';
import { compileJtltStylesheet } from '@jarenjs/json/jtlt';
import {
  compileDataRef,
  compileJSONPath,
  compileJSONPointer,
  parseJSONPath,
  parseRelativeJSONPointer,
} from '@jarenjs/json';
import type {
  JSONPathAst,
  JSONPathNode,
  JSONPathQuery,
  JSONPathSegment,
  JSONPathSelector,
  JsonPointerGetter,
  RelativeJsonPointer,
  RelativeJsonPointerResolver,
} from '@jarenjs/json';
import { JarenValidator } from '@jarenjs/validate';
import type {
  DataKeywordSchema,
  DollarDataRef,
  FormatCompiler,
  JSONSchema,
} from '@jarenjs/validate';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { stringFormats } from '@jarenjs/formats';
import type {
  FormatCompiler as StructuralFormatCompiler,
  FormatValidator,
} from '@jarenjs/formats';
import { getSchemaDraftByVersion } from '@jarenjs/refs';
import type { SchemaDraftInfo } from '@jarenjs/refs';
import { buildFormModel } from '@jarenjs/forms';

const validator = new JarenValidator();
validator.addFormats(stringFormats);
const validate = validator.compile({ type: 'string' });
const query = compileJsonQuery('$.name');
const render = compileJtltStylesheet([
  { match: '$.name', body: ['Hello ', '$'] },
]);
const form = buildFormModel({
  type: 'object',
  properties: {
    name: { type: 'string' },
  },
});

isStringType(query({ name: 'Jaren' }));
getStringLength(render({ name: 'Jaren' }));
validate('Jaren');
createTypeTestCompiler(validator);
getSchemaDraftByVersion(2020);
form.children;

// Named type exports of @jarenjs/validate
const minRef: DollarDataRef = { $data: '1/minNameLength' };
const dataKeyword: DataKeywordSchema = { minimum: '/limits/min', format: '/limits/format' };
const userSchema: JSONSchema = {
  $id: 'https://example.com/user',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    name: { type: 'string', minLength: minRef, format: 'email' },
    age: { type: 'integer', minimum: 0 },
  },
  required: ['name'],
  data: dataKeyword,
  'x-custom-keyword': true,
};
const validateUser = validator.compile(userSchema);
validateUser({ name: 'jaren@example.com' });
const customFormat: FormatCompiler = (schemaObj, jsonSchema) =>
  (data) => typeof data === 'string' && data !== jsonSchema.format;
validator.addFormat('not-the-format-name', customFormat);

// Named type exports of @jarenjs/json
const pathQuery: JSONPathQuery = compileJSONPath('$.users[*].name');
const ast: JSONPathAst = parseJSONPath('$.users[*].name');
const segments: JSONPathSegment[] = ast.segments;
const selectors: JSONPathSelector[] = segments[0].selectors;
const nodes: JSONPathNode[] = pathQuery.nodes({ users: [{ name: 'Jaren' }] });
void pathQuery.ast.relative;
void nodes.map((node) => `${node.path}=${JSON.stringify(node.value)}`);
void selectors.length;
const getName: JsonPointerGetter = compileJSONPointer('/name');
getName({ name: 'Jaren' });
const relPtr: RelativeJsonPointer = parseRelativeJSONPointer('1/sibling');
void (relPtr.levels + relPtr.segments.length + (relPtr.hash ? 1 : 0));
const resolveRef: RelativeJsonPointerResolver = compileDataRef('0/name');
resolveRef({ name: 'Jaren' }, '');

// Named type exports of @jarenjs/formats
const emailCompiler: StructuralFormatCompiler = stringFormats['email'];
void emailCompiler;
const alwaysString: FormatValidator = (data) => typeof data === 'string';
alwaysString('Jaren', '/name');

// Named type exports of @jarenjs/refs
const draft: SchemaDraftInfo = getSchemaDraftByVersion(2020);
void `${draft.draft} (${draft.schema.length} schemas)`;

// @jarenjs/md — parse, compile, project, plugins
import {
  parseMarkdown,
  compileMarkdown,
  toMarkdown,
  mdToVnode,
  walkAst,
  parseFrontmatter,
  definePlugin,
  loadMarkdown,
} from '@jarenjs/md';
import { highlightPlugin, mermaidPlugin } from '@jarenjs/md/plugins';

const mdPlugins = [highlightPlugin(), mermaidPlugin()];
const mdDoc = parseMarkdown('# Hi *there*', { plugins: mdPlugins });
void mdDoc.meta.hash;
const compiledMd = compileMarkdown('# Hi', { retainSource: false });
void compiledMd.toVnode();
void compiledMd.externals();
void toMarkdown(mdDoc);
void mdToVnode(mdDoc, { plugins: mdPlugins });
walkAst(mdDoc.ast, (node) => void node.type);
const fm = parseFrontmatter('---\ntitle: x\n---\nbody');
void `${fm.lang}: ${JSON.stringify(fm.data)} :: ${fm.body}`;
void definePlugin({ name: 'noop-plugin' });
void (async () => (await loadMarkdown('https://example.com/a.md')).frontmatter);

// @jarenjs/view — the renderer surface, destroy included
import { createDomRenderer } from '@jarenjs/view';

const renderDom = createDomRenderer(({} as any), {
  onEvent: (binding, event) => void [binding, event],
});
renderDom(['p', {}, 'hi']);
renderDom.destroy();

// @jarenjs/app — app handle (observe/destroy), tasks, focus
import { createApp, createTaskEffect, createFocusEffect } from '@jarenjs/app';

const app = createApp({ state: {}, view: [{ match: '$', body: ['p', {}, 'x'] }] }, {
  validateState: (next, context) =>
    context.action === null ? true : { valid: next !== undefined },
  maxTurns: 100,
});
app.dispatch('noop');
void app.getState();
const unobserve = app.observe((tx) => void `${tx.seq}:${tx.action}:${tx.status}`);
unobserve();
const unsubscribe = app.subscribe((state, changes) => void [state, changes]);
unsubscribe();
app.stop();
app.destroy();

// TaskRun allows a synchronous (non-Promise) return
const syncTask = createTaskEffect((props, signal) => ({ echoed: props, aborted: signal.aborted }));
const asyncTask = createTaskEffect(async () => ({}));
syncTask.cancel();
asyncTask.cancelAll();
syncTask.dispose();

const focus = createFocusEffect({ container: ({} as any) });
focus.flush();
focus.dispose();

// @jarenjs/json/query — compile options (limits/functions/collations),
// dependencies and explain()
const limitedQuery = compileJsonQuery('$.rows[*]', {
  limits: { sequenceItems: 100, resultItems: 10 },
  functions: { double: (n: number) => n * 2 },
  collations: { flipped: (a: string, b: string) => b.localeCompare(a) },
});
const deps: readonly string[] = limitedQuery.dependencies.functions;
void deps;
void limitedQuery.dependencies.collations.length;
const explanation = limitedQuery.explain();
void explanation.limits?.sequenceItems;
void limitedQuery.first({ rows: [] });
void limitedQuery.exists({ rows: [] });
void limitedQuery.ebv({ rows: [1] });

// @jarenjs/forms — the session view model surface
import { buildFormViewModel } from '@jarenjs/forms';

const sessionTree = buildFormViewModel(form, { name: 'Jo' }, {
  session: {
    initial: { name: 'Jo' },
    touched: ['/name'],
    submitted: false,
    idPrefix: 'consumer',
  },
});
if (sessionTree !== null && sessionTree.session !== undefined) {
  const dirtyPaths: string[] = sessionTree.session.dirtyPaths;
  void dirtyPaths;
  void (sessionTree.session.dirty && sessionTree.session.submitted);
  void (sessionTree.session.errorCount + sessionTree.session.serverErrorCount);
}
