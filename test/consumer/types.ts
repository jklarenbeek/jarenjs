import { isStringType } from '@jarenjs/core';
import { getStringLength } from '@jarenjs/core/string';
import {
  compileJsonQuery, analyzeQuery, annotateTypes,
  NODE_KINDS, TYPE_TAGS, AST_VERSION,
} from '@jarenjs/json/query';
import { compileJtltStylesheet } from '@jarenjs/json/jtlt';
import {
  canonicalizeJson,
  compileDataRef,
  compileJSONPath,
  compileJSONPointer,
  createJSONPatch,
  parseJSONPath,
  parseRelativeJSONPointer,
} from '@jarenjs/json';
import type {
  JSONPathAst,
  JSONPathFunction,
  JSONPathNode,
  JSONPathOptions,
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
void [...pathQuery.iterate({ users: [{ name: 'Jaren' }] })];
const isEven: JSONPathFunction = {
  params: ['value'],
  returns: 'logical',
  evaluate: (v: unknown) => typeof v === 'number' && v % 2 === 0,
};
const pathOptions: JSONPathOptions = { pathFunctions: { is_even: isEven } };
void compileJSONPath('$.users[?is_even(@.age)].name', pathOptions);
const canonical: string = canonicalizeJson({ b: 1, a: 2 });
void canonical;
void createJSONPatch([1, 2], [1, 9, 2], { arrayDiff: 'minimal' });
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

// @jarenjs/json/query — the published normalized form (Appendix C):
// analyzeQuery, the version/kind constants and the type pass
const analysis = analyzeQuery({ $eq: ['$.a', '$x'] });
const astVersion: number = analysis.astVersion;
void astVersion;
void analysis.frameSize;
const analysisExternals: readonly { name: string; slot: number }[] = analysis.externals;
void analysisExternals;
void analysis.dependencies.operators.length;
const kinds: readonly string[] = NODE_KINDS;
void kinds;
const versionPin: number = AST_VERSION;
void versionPin;
const annotated = annotateTypes(analysis, {
  typeOf: (node: unknown) => (node ? 'string' : null),
});
void annotated;
const tags: readonly string[] = TYPE_TAGS;
void tags;
const withAnalysis = compileJsonQuery('$.a', { analysis: true });
void withAnalysis.analysis;

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

// @jarenjs/validate — the compiled-validator type contract.
// The `collectErrors` option decides the return shape, and it is carried in
// the class type parameter so consumers never see the undiscriminated union.

// Default instance: a type guard over `unknown`, usable as a plain boolean.
const booleanMode = new JarenValidator();
const isString = booleanMode.compile({ type: 'string' });
const stringVerdict: boolean = isString(JSON.parse('"x"'));
void stringVerdict;

// The compiled validator takes `unknown`, not `any`: member access on its
// argument's type must not be allowed. If this ever compiles, `any` has
// leaked back into the public surface.
// @ts-expect-error the validator returns boolean, not an indexable value
void isString('x').anything;

// An explicit `false` behaves exactly like the default.
const explicitBooleanMode = new JarenValidator({ collectErrors: false });
const explicitVerdict: boolean = explicitBooleanMode.compile({ type: 'string' })('x');
void explicitVerdict;

// Collect mode: `{ valid, errors }`, with the full ValidationError shape.
const collectMode = new JarenValidator({ collectErrors: true });
const collected = collectMode.compile({ type: 'string' })(1);
const collectedValid: boolean = collected.valid;
const collectedCount: number = collected.errors.length;
void (collectedValid && collectedCount >= 0);
if (collected.errors.length > 0) {
  const issue = collected.errors[0];
  const issueFields: [string, string, string, string, string] = [
    issue.keyword,
    issue.instancePath,
    issue.schemaPath,
    issue.msgid,
    issue.message,
  ];
  void issueFields;
  void (issue.params as Record<string, unknown>);
}

// A caller-asserted type turns the validator into a narrowing type guard.
type ConsumerUser = { name: string; age: number };
const isConsumerUser = booleanMode.compile<ConsumerUser>(userSchema);
const unknownInput: unknown = JSON.parse('{}');
if (isConsumerUser(unknownInput)) {
  const narrowedName: string = unknownInput.name;
  const narrowedAge: number = unknownInput.age;
  void (narrowedName + String(narrowedAge));
}

// @jarenjs/validate/normalize — the normalization pass.
// Input and output types are both caller-assertable, because materializing
// defaults makes the accepted input and the normalized output differ.
import { compileNormalizer } from '@jarenjs/validate/normalize';
import type { NormalizeOptions, Normalizer } from '@jarenjs/validate/normalize';

const normalizeOptions: NormalizeOptions = {
  useDefaults: true,
  removeAdditional: 'all',
  coerceTypes: true,
  trimStrings: true,
};

type ContractInput = { name: string; port?: number };
type ContractOutput = { name: string; port: number };

const normalizeContract: Normalizer<ContractInput, ContractOutput> =
  compileNormalizer<ContractInput, ContractOutput>(userSchema, normalizeOptions);
const normalizedPort: number = normalizeContract({ name: 'jaren' }).port;
void normalizedPort;

// Untyped use stays honest: unknown in, unknown out.
const normalizeUnknown = compileNormalizer(userSchema);
const normalizedUnknown: unknown = normalizeUnknown(JSON.parse('{}'));
void normalizedUnknown;

// The fluent methods must preserve the collectErrors type parameter: this is
// the exact chained factory the Zod migration guide documents, and a bare
// `JarenValidator` return would silently reset it to the boolean default.
const chainedFactory = new JarenValidator({ collectErrors: true })
  .addFormats(stringFormats)
  .addSchema({ $id: 'https://example.com/chained', type: 'object' });
const chainedResult = chainedFactory.compile({ type: 'string' })('x');
const chainedValid: boolean = chainedResult.valid;
const chainedIssues: number = chainedResult.errors.length;
void (chainedValid && chainedIssues >= 0);

// @jarenjs/emit — the type side of the cyclic verification.
//
// `emit-generated.ts` is produced by the generator from test/emit/corpus.js;
// a node test fails if it drifts. These assertions are the independent oracle:
// TypeScript itself decides whether the generated types correspond to what the
// validator accepts, and `npm run test:types` is where that verdict lands.
//
//   - a schema-VALID instance must be assignable   → the type is never NARROWER
//     than the schema, so it cannot reject data the service accepts
//   - a structurally INVALID instance must not be  → the type is never WIDER
//     than the schema, so it cannot certify data the service rejects
//   - a constraint-invalid instance IS assignable  → the documented widening;
//     TypeScript cannot express minLength, and the generated file says so
import type { Account, Node as EmitNode, Strict } from './emit-generated.js';

// valid → must type-check
const emitValid1: Account = { id: 'abc' };
const emitValid2: Account = { id: 'abc', age: 3, role: 'admin', tags: ['x'] };
// The schema omits `additionalProperties`, so it is open and this document
// VALIDATES. The type has to accept it, or the generator is narrower than the
// schema it was generated from.
const emitOpenExtra: Account = { id: 'abc', extra: true };
const emitStrictValid: Strict = { kind: 'a' };
// @ts-expect-error `additionalProperties: false` closes the object, so an
// extra member really is a structural error here
const emitStrictBad: Strict = { kind: 'a', extra: 1 };
const emitValid3: EmitNode = { label: 'root' };
const emitValid4: EmitNode = { label: 'root', children: [{ label: 'kid', children: [] }] };
void [emitValid1, emitValid2, emitValid3, emitValid4,
  emitOpenExtra, emitStrictValid, emitStrictBad];

// structurally invalid → must NOT type-check. Each @ts-expect-error becomes an
// error itself if the generated type ever widens enough to accept the value.
// @ts-expect-error id must be a string
const emitBad1: Account = { id: 42 };
// @ts-expect-error id is required
const emitBad2: Account = { age: 1 };
// @ts-expect-error 'owner' is outside the enum
const emitBad3: Account = { id: 'abc', role: 'owner' };
// @ts-expect-error tags items must be strings
const emitBad4: Account = { id: 'abc', tags: [1] };
// @ts-expect-error label must be a string
const emitBad5: EmitNode = { label: 1 };
// @ts-expect-error label is required
const emitBad6: EmitNode = { children: [] };
// @ts-expect-error a child must itself be a Node
const emitBad7: EmitNode = { label: 'root', children: [{ notALabel: true }] };
void [emitBad1, emitBad2, emitBad3, emitBad4, emitBad5, emitBad6, emitBad7];

// constraint-invalid → type-checks, because no type can carry minLength.
// The generated file documents it; this pins the honest boundary.
const emitWidened: Account = { id: 'ab' };
void emitWidened;

// The accepted/normalized variant pair. `compileNormalizer` makes a contract's
// input and output shapes differ, and these two declarations are that
// difference made checkable:
//
//   - a RAW caller value (defaults absent, port still a transport string)
//     must satisfy ConfigInput and must NOT satisfy Config
//   - the NORMALIZED value must satisfy Config
//
// This is what a Contract<Input, Output> boundary needs, and it is only
// trustworthy because the same normalize options drove both the generated
// types and the runtime normalizer.
import type { Config, ConfigInput } from './emit-generated.js';

const emitRaw: ConfigInput = { name: 'a', port: '9000' };
void emitRaw;

// @ts-expect-error a raw input is not the normalized shape: host is absent and port is a string
const emitRawAsOutput: Config = { name: 'a', port: '9000' };
void emitRawAsOutput;

const emitNormalized: Config = { name: 'a', host: 'localhost', port: 9000 };
void emitNormalized;

// @ts-expect-error the normalized shape requires the defaulted members
const emitMissingDefaults: Config = { name: 'a' };
void emitMissingDefaults;

// A root that IS a $ref aliases its target instead of collapsing to unknown.
import type { Id as EmitId, Wide, Base } from './emit-generated.js';

const emitRootAlias: EmitId = 'abc';
void emitRootAlias;
// @ts-expect-error the root alias really is the target type, not unknown
const emitRootAliasBad: EmitId = 1;
void emitRootAliasBad;

// A plain-anchor $ref with siblings: both the target and the siblings apply.
const emitWide: Wide = { id: 'x', extra: 1 };
const emitWideOpen: Wide = { id: 'x', extra: 1, more: true };
const emitBase: Base = { id: 'x' };
void [emitWide, emitWideOpen, emitBase];
// @ts-expect-error the referenced Base still requires id
const emitWideBad1: Wide = { extra: 1 };
// @ts-expect-error the $ref siblings still require extra
const emitWideBad2: Wide = { id: 'x' };
// @ts-expect-error extra must be a number
const emitWideBad3: Wide = { id: 'x', extra: 'n' };
void [emitWideBad1, emitWideBad2, emitWideBad3];

// Tuples: prefixItems does not fix the length. minItems makes the first
// position required, the omitted `items` leaves the array open.
import type { Pair, Exact } from './emit-generated.js';

const emitPair1: Pair = ['a'];
const emitPair2: Pair = ['a', 2];
const emitPair3: Pair = ['a', 2, true, null];
void [emitPair1, emitPair2, emitPair3];
// @ts-expect-error minItems makes the first element required
const emitPairBad1: Pair = [];
// @ts-expect-error the first element must be a string
const emitPairBad2: Pair = [1];
// @ts-expect-error the second element must be a number
const emitPairBad3: Pair = ['a', 'b'];
void [emitPairBad1, emitPairBad2, emitPairBad3];
// maxItems is a dropped constraint: the validator rejects this, the open
// rest accepts it, and the generated file says why.
const emitPairWidened: Pair = ['a', 2, true, null, 'five'];
void emitPairWidened;

// `items: false` with met minItems is the one case that really is exact.
const emitExact: Exact = ['a', 2];
void emitExact;
// @ts-expect-error minItems closes the short end
const emitExactBad1: Exact = ['a'];
// @ts-expect-error items: false closes the long end
const emitExactBad2: Exact = ['a', 2, 3];
void [emitExactBad1, emitExactBad2];

// No `type` means no inferred container: the validator accepts primitives
// without reading `properties`, so the type must too.
import type { Loose } from './emit-generated.js';

const emitLoose1: Loose = { a: 'x' };
const emitLoose2: Loose = 'hello';
const emitLoose3: Loose = 42;
const emitLoose4: Loose = [1, 'x'];
const emitLoose5: Loose = null;
void [emitLoose1, emitLoose2, emitLoose3, emitLoose4, emitLoose5];
// @ts-expect-error an object with a wrong `a` is structurally invalid
const emitLooseBad1: Loose = { a: 1 };
// @ts-expect-error an object without the required `a` is structurally invalid
const emitLooseBad2: Loose = {};
void [emitLooseBad1, emitLooseBad2];

// A closed empty object must reject primitives — an empty interface would
// let them through TypeScript's weak-type escape hatch.
import type { Empty } from './emit-generated.js';

const emitEmpty: Empty = {};
void emitEmpty;
// @ts-expect-error a member is forbidden by additionalProperties: false
const emitEmptyBad1: Empty = { a: 1 };
// @ts-expect-error a primitive is not an object
const emitEmptyBad2: Empty = 'x';
void [emitEmptyBad1, emitEmptyBad2];

// Literals versus accepted-side coercion: the normalizer turns '2' into 2
// before the enum check runs, so the transport string satisfies the accepted
// side and only the literal union satisfies the normalized side.
import type { Level, LevelInput } from './emit-generated.js';

const emitLevel: Level = { level: 2 };
const emitLevelRaw: LevelInput = { level: '2' };
void [emitLevel, emitLevelRaw];
// @ts-expect-error the enum is integers after normalization
const emitLevelBad1: Level = { level: '2' };
// @ts-expect-error 4 is outside the enum on both sides
const emitLevelBad2: Level = { level: 4 };
void [emitLevelBad1, emitLevelBad2];

// A required member with an enabled default stays optional on the accepted
// side: the normalizer materializes it before validation ever runs.
import type { Job, JobInput } from './emit-generated.js';

const emitJobRaw: JobInput = { cmd: 'ls' };
const emitJobOut: Job = { cmd: 'ls', retries: 0 };
void [emitJobRaw, emitJobOut];
// @ts-expect-error cmd has no default, so it stays required on input
const emitJobRawBad: JobInput = {};
// @ts-expect-error retries is required after normalization
const emitJobOutBad: Job = { cmd: 'ls' };
void [emitJobRawBad, emitJobOutBad];
// Integer-ness is a documented widening: the validator rejects 1.5 retries,
// `number` accepts it, and the generated file records type="integer".
const emitJobWidened: Job = { cmd: 'ls', retries: 1.5 };
void emitJobWidened;

// Normalization does not reach into anyOf branches, because
// compileNormalizer does not descend them. The branch default never
// materializes and the branch integer is never coerced — on either side.
import type { Choice, ChoiceInput } from './emit-generated.js';

const emitChoiceRaw: ChoiceInput = { opt: {} };
const emitChoiceRawCoerce: ChoiceInput = { port: '9000', opt: { level: 3 } };
// mode is NOT required after normalizing: the branch default never runs.
const emitChoiceOut: Choice = { port: 8080, opt: {} };
const emitChoiceOutStr: Choice = { port: 1, opt: 'x' };
void [emitChoiceRaw, emitChoiceRawCoerce, emitChoiceOut, emitChoiceOutStr];
// @ts-expect-error the normalized shape materializes port
const emitChoiceRawAsOut: Choice = { opt: {} };
// @ts-expect-error level sits under anyOf, so its integer is never coerced
const emitChoiceBadLevel: ChoiceInput = { opt: { level: '3' } };
void [emitChoiceRawAsOut, emitChoiceBadLevel];

// A boolean root under normalization options emits exactly one declaration.
import type { Anything } from './emit-generated.js';

const emitAnything: Anything = { whatever: true };
void emitAnything;

// @jarenjs/emit — the programmatic surface is fully typed. Passing
// `normalize` and `variantSuffix` here is the selective route the CLI flags
// wrap; it used to raise an excess-property error because the options type
// did not declare them.
import { compileEmitModel, emitTypeScript, emitMarkdown } from '@jarenjs/emit';
import type {
  EmitDeclaration,
  EmitModel,
  EmitModelOptions,
  EmitTypeRef,
} from '@jarenjs/emit/model';

const emitOptions: EmitModelOptions = {
  name: 'Contract',
  source: 'contract.json',
  openObjects: 'open',
  normalize: { useDefaults: true, coerceTypes: (node) => node['x-coerce'] === true },
  variantSuffix: 'Raw',
  reserved: ['TakenElsewhere'],
};
const emitModel: EmitModel = compileEmitModel({
  type: 'object',
  properties: { port: { type: 'integer', default: 8080, 'x-coerce': true } },
}, emitOptions);
const emitDecls: EmitDeclaration[] = emitModel.declarations;
const emitRootName: string | null = emitModel.root;
const emitFirstType: EmitTypeRef = emitDecls[0].type;
void [emitRootName, emitFirstType.kind, emitDecls[0].variant];

const emittedSource: string = emitTypeScript({ type: 'string' },
  { name: 'Plain', banner: false, normalize: { useDefaults: true } });
const emittedDocs: string = emitMarkdown({ type: 'string' }, { name: 'Plain' });
void [emittedSource, emittedDocs];

// @jarenjs/flow — compiled machine, pure step, session over it
import { compileFsm, createFsmSession, FlowCompileError, FlowRuntimeError } from '@jarenjs/flow';

const fsm = compileFsm({
  initial: 'idle',
  states: ['idle', { id: 'done', final: true }],
  transitions: [{ from: 'idle', event: 'finish', guard: '$.payload.ok', to: 'done' }],
});
const fsmInitial: string | null = fsm.initial;
const fsmStates: readonly string[] = fsm.states;
const fsmEvents: readonly string[] = fsm.events('idle');
const fsmResult = fsm.step('idle', 'finish', { payload: { ok: true }, context: null });
const fsmMoved: boolean = fsmResult.changed;
const fsmErrors: { code: string, docPath: string, message: string }[] = fsmResult.errors;
void [fsmInitial, fsmStates, fsmEvents, fsmMoved, fsmErrors, fsm.final('done')];

const fsmSession = createFsmSession(fsm, 'idle');
const fsmDone: boolean = fsmSession.done;
void [fsmSession.state, fsmSession.can('finish'), fsmSession.send('finish').state, fsmDone];
void [FlowCompileError, FlowRuntimeError];

import { fsmToApp, fsmStateSchema } from '@jarenjs/flow';

const hosted = fsmToApp({
  initial: 'idle',
  states: ['idle'],
  transitions: [{ from: 'idle', event: 'go', to: 'idle' }],
}, { pointer: '/machine', namespace: 'machine/' });
const hostedEvents: string[] = hosted.events;
const hostedCurrent: string | null = hosted.slice.current;
void [hostedEvents, hostedCurrent, hosted.actions['machine/go']];
const sliceSchema = fsmStateSchema({ initial: 'idle', states: ['idle'], transitions: [] });
const sliceEnum: string[] = sliceSchema.properties.current.enum;
void sliceEnum;

import { compileDag } from '@jarenjs/flow';

const dag = compileDag({
  $dag: '0.1',
  nodes: {
    i: { kind: 'input' },
    t: { kind: 'task', run: 'work', with: { n: 1 } },
    o: { kind: 'output' },
  },
  edges: [{ from: 'i', to: 't' }, { from: 't', to: 'o' }],
}, { tasks: { work: async (props, signal) => [props.with, props.input, signal.aborted] } });
const dagNodes: readonly string[] = dag.nodes;
const dagOutput: string = dag.output;
void [dagNodes, dagOutput];
const dagResult: Promise<unknown> = dag.run({ rows: [] }, {
  onNode: (rec) => void `${rec.id}:${rec.status}:${rec.ms}`,
});
void dagResult.catch(() => null);

// @jarenjs/linq — the typed fluent surface: precise inference on the
// common path, honest unknown on the exotic path, never a wrong type.
// Every claim here has a runtime twin in test/linq/types.test.js.
import {
  from as linqFrom, fromDocument as linqFromDocument,
  LinqBuildError, LinqRuntimeError, LINQ_CODES, Sequence,
} from '@jarenjs/linq';
import type { DateTime } from '@jarenjs/linq';

interface LinqUser {
  id: number;
  name: string;
  age: number;
  active: boolean;
  created: DateTime;
  tags: string[];
  address?: { city: string };
}
const linqUsers: LinqUser[] = [];

// inference through the chain: the projection narrows the element type
const linqAdults = linqFrom(linqUsers)
  .where((u) => u.age.gt(21).and(u.active))
  .orderBy((u) => u.name)
  .select((u) => ({ id: u.id, label: u.name.upper(), city: u.address.city }));
const linqRows: { id: number, label: string, city: string }[] = linqAdults.toArray();
void linqRows;

// terminals: first is optional, single is not; min/max follow the family
const linqFirst: { id: number, label: string, city: string } | undefined =
  linqAdults.firstOrDefault();
void linqFirst;
const linqOne: { id: number, label: string, city: string } = linqAdults.single();
void linqOne;
const linqCount: number = linqAdults.count();
void linqCount;
const linqMinName: string = linqFrom(linqUsers).select((u) => u.name).min();
void linqMinName;
const linqMinAge: number = linqFrom(linqUsers).select((u) => u.age).min();
void linqMinAge;

// groupBy types its key (nullable: an empty grouping key reads null)
const linqGroups: { key: string | null, items: LinqUser[] }[] =
  linqFrom(linqUsers).groupBy((u) => u.name).toArray();
void linqGroups;

// the DateTime brand exposes date operators; plain strings do not
void linqFrom(linqUsers).where((u) => u.created.year().ge(2020)).count();

// params are typed through the second callback argument
void linqFrom(linqUsers)
  .params({ minAge: 21, city: 'x' })
  .where((u, p) => u.age.ge(p.minAge).and(u.address.city.eq(p.city)))
  .toArray();

// arrays fan out; aggregates compose
void linqFrom(linqUsers).where((u) => u.tags.all().count().gt(0)).count();

// the negative cases — each pinned so it FAILS the build if it ever
// starts compiling
// @ts-expect-error — comparing a number expression to a string
void linqFrom(linqUsers).where((u) => u.age.gt('x'));
// @ts-expect-error — a misspelled member is not on the object surface
void linqFrom(linqUsers).where((u) => u.emial.exists());
// @ts-expect-error — a string method on a number expression
void linqFrom(linqUsers).where((u) => u.age.upper());
// @ts-expect-error — a date operator on a plain (unbranded) string
void linqFrom(linqUsers).where((u) => u.name.year());
// @ts-expect-error — an undeclared parameter name
void linqFrom(linqUsers).params({ minAge: 1 }).where((u, p) => u.age.ge(p.maxAge));
// @ts-expect-error — arithmetic on a boolean expression
void linqFrom(linqUsers).where((u) => u.active.add(1));

// providers keep the element type the caller declares; unknown otherwise
const linqProvider = { execute: (_d: unknown, _o: { externals: Record<string, unknown> }) => [] as unknown };
const typedRemote: Sequence<LinqUser> = linqFrom<LinqUser>(linqProvider);
void typedRemote.toDocument();
const untypedRemote = linqFrom(linqProvider);
const untypedRows: unknown[] = untypedRemote.toArray();
void untypedRows;
void linqFromDocument<LinqUser>(linqUsers, '$[*]').toArray();

const linqCodes: Readonly<Record<string, string>> = LINQ_CODES;
void linqCodes.JL2001;
void (LinqBuildError.name.length + LinqRuntimeError.name.length);
for (const row of linqFrom(linqUsers)) void row.id;
