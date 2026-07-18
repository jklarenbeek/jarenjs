import { Link } from 'react-router-dom';
import { Container } from '@components/layout/Container';
import { DraftSupport } from '@components/features/DraftSupport';
import { CodeBlock } from '@components/ui/code-block';
import { Badge } from '@components/ui/badge';
import { Card, CardContent } from '@components/ui/card';
import { ExternalLink } from 'lucide-react';

const REPO = 'https://github.com/jklarenbeek/jarenjs';

/* ------------------------------------------------------------------ */
/* code samples                                                        */
/* ------------------------------------------------------------------ */

const basicExample = `import { JarenValidator } from '@jarenjs/validate';
import { stringFormats } from '@jarenjs/formats';

const validator = new JarenValidator()
  .addFormats(stringFormats);

const validate = validator.compile({
  type: 'object',
  properties: {
    name: { type: 'string' },
    email: { type: 'string', format: 'email' },
  },
  required: ['name'],
});

validate({ name: 'Ada', email: 'ada@example.com' }); // true`;

const errorCollectionExample = `const validator = new JarenValidator({
  collectErrors: true,  // return { valid, errors } instead of a boolean
  skipErrors: false,    // keep going after the first failure
});

const validate = validator.compile(schema);
const result = validate(invalidData);
// result.valid  -> false
// result.errors -> [{ keyword, instancePath, schemaPath, params, message }]`;

const refExample = `const validator = new JarenValidator();

validator.addSchema({
  $id: 'https://example.com/address',
  type: 'object',
  properties: { street: { type: 'string' }, city: { type: 'string' } },
});

const validate = validator.compile({
  type: 'object',
  properties: {
    name: { type: 'string' },
    address: { $ref: 'https://example.com/address' },
  },
});`;

const queryKeywordExample = `// $query embeds a Jaren JSON Query as a cross-field assertion —
// asserted by effective boolean value against the current instance.
const validate = validator.compile({
  type: 'object',
  properties: {
    start: { type: 'string', format: 'date' },
    end: { type: 'string', format: 'date' },
    lines: { type: 'array' },
    total: { type: 'number' },
  },
  allOf: [
    { $query: { $le: ['$.start', '$.end'] } },              // date ordering
    { $query: { $eq: ['$.total', { $sum: '$.lines[*].amount' }] } },
  ],
});`;

const pointerExample = `import {
  compileJSONPointer, compileRelativeJSONPointer, JSONPOINTER_NOTHING,
} from '@jarenjs/json';

const get = compileJSONPointer('/store/book/0/title');
get(data);                       // 'Sayings of the Century'
get({}) === JSONPOINTER_NOTHING; // misses return a sentinel, never throw

const sibling = compileRelativeJSONPointer('1/price');
sibling(data, '/store/book/0/title'); // 8.95`;

const patchExample = `import {
  compileJSONPatch, applyJSONPatch, createJSONPatch,
  applyMergePatch, createMergePatch,
} from '@jarenjs/json';

// compile once, apply many times — copy-on-write, atomic
const apply = compileJSONPatch([
  { op: 'test', path: '/version', value: 5 },      // precondition
  { op: 'replace', path: '/user/name', value: 'Bob' },
  { op: 'add', path: '/user/tags/-', value: 'admin' },
]);
const next = apply(doc);   // doc untouched; unchanged subtrees shared

createJSONPatch(doc, next);            // the diff emits RFC 6902 ops
applyMergePatch(doc, { temp: null });  // RFC 7396: null deletes
createMergePatch(doc, next);           // ...and the merge-patch diff`;

const writeExample = `import {
  compileJSONPointerSetter, removeAtJSONPointer,
  compileJSONPathSetter, removeAtJSONPath,
  jsonPointerFromJSONPath, jsonPathFromJSONPointer,
} from '@jarenjs/json';

// a target is a pointer, a normalized path, or any singular query
const setZip = compileJSONPointerSetter('/address/zip');
setZip(doc, '10999');                 // copy-on-write: doc untouched
setZip(doc, (old) => old ?? '10115'); // setters take updater functions
removeAtJSONPointer(doc, '$.store.book[-1]'); // negative = from the end

// ...or write at EVERY node a query selects (reverse document order,
// so array shifts and nested matches compose)
compileJSONPathSetter('$..price')(doc, (p) => p * 1.21);
removeAtJSONPath(doc, '$.store.book[?@.price > 20]');

// the addressing bridge, for when locations cross API boundaries
jsonPointerFromJSONPath("$['store']['book'][0]"); // '/store/book/0'
jsonPathFromJSONPointer('/store/book/0'); // "$['store']['book'][0]"`;

const joslExample = `import { parseJosl, parseToml, stringifyToml } from '@jarenjs/josl';
import { createStreamReader } from '@jarenjs/josl/stream';
import { parseJsonx } from '@jarenjs/josl/jsonx';

// TOML 1.0 + JavaScript's obvious types:
// null, 123n, /regexp/i, real dates, [[]] root arrays
const doc = parseJosl(joslText);
parseToml(tomlText);                    // strict: passes all of toml-test 1.0.0
stringifyToml(doc, { onNull: 'omit' }); // downlevel JOSL -> TOML

// streaming reader: document-order events with JSON-Pointer paths;
// chunks may split ANY token — built for LLM output
const reader = createStreamReader({
  onEvent: (e) => console.log(e.type, e.path.join('/')),
});
for (const chunk of chunks) reader.feed(chunk);
const value = reader.end();

// JSONX: the same first-class types over JSON
parseJsonx('{"big": 123n, "re": /a+/g, "when": 2026-07-18}');`;

const pathExample = `import { compileJSONPath, queryJSONPath } from '@jarenjs/json';

const query = compileJSONPath('$..book[?@.price < 10].title');
query(data);        // values
query.paths(data);  // RFC 9535 normalized paths
query.nodes(data);  // { values, paths }

queryJSONPath('$.store.bicycle.color', data); // one-shot, cached`;

const queryExample = `import { compileJsonQuery } from '@jarenjs/json';
import { createTypeTestCompiler } from '@jarenjs/validate/query';

const query = compileJsonQuery({
  $for: { b: '$.store.book[*]', r: '$.ratings[*]' },
  $where: { $eq: ['$b.isbn', '$r.isbn'] },
  $orderby: '$b.price',
  $return: { title: '$b.title', stars: '$r.stars' },
}, {
  // optional: lets $valid / $assert / $as compile JSON Schema literals
  compileTypeTest: createTypeTestCompiler(),
});

query(data);           // the joined, ordered sequence
query.externals;       // names of free variables, bind via query(data, {...})`;

const jsltExample = `import { compileJsltStylesheet, transformJson } from '@jarenjs/json/jslt';

// rules match by JSONPath (position) and/or JSON Schema (shape);
// bodies are query documents evaluated at the matched node
const transform = compileJsltStylesheet([
  { match: '$..price', body: { $mul: ['$', 1.21] } },
]);

const out = transform(data);   // prices changed, everything else SHARED
transformJson([], data) === data; // identity returns the input reference`;

const xqueryExample = `import { parseXQuery, compileXQuery } from '@jarenjs/json/xquery';

const doc = parseXQuery(
  'for $b in $doc?store?book?* where $b?price < 10 return $b?title');
// -> a Jaren query document (plain JSON), $doc as external parameter

const query = compileXQuery('avg($doc?store?book?*?price)');
query(null, { doc: data }); // 13.48`;

const formsExample = `import {
  buildFormModel, compileFormRules, evaluateFormRules,
  formRulesToQueryAssertions,
} from '@jarenjs/forms';

const model = buildFormModel(schema);      // field descriptor tree
const rules = compileFormRules(model);     // x-form: visible/enabled/
                                           // computed/assert/message
const state = evaluateFormRules(rules, formData); // per keystroke

// write the rule once, enforce it on submit too:
const submitSchema = formRulesToQueryAssertions(schema);`;

const formatsExample = `import {
  stringFormats, numberFormats, dateTimeFormats, jsonFormats,
  formatTesters,
} from '@jarenjs/formats';

new JarenValidator()
  .addFormats(stringFormats)     // email, uuid, iri, iban, isbn10, ...
  .addFormats(numberFormats)     // int8..uint64, float16..float64
  .addFormats(dateTimeFormats)   // date-time, duration, ...
  .addFormats(jsonFormats);      // json-pointer, json-path (full RFC 9535)

formatTesters['email']('ada@example.com'); // bare predicates, no schema`;

/* ------------------------------------------------------------------ */

const NAV = [
  {
    title: 'Getting started',
    items: [
      ['installation', 'Installation'],
      ['quick-start', 'Quick start'],
    ],
  },
  {
    title: '@jarenjs/validate',
    items: [
      ['validation-options', 'Options'],
      ['error-handling', 'Error handling'],
      ['refs', '$ref resolution'],
      ['query-keyword', 'The $query keyword'],
      ['draft-support', 'Draft support'],
    ],
  },
  {
    title: '@jarenjs/json',
    items: [
      ['json-pointer', 'JSON Pointer'],
      ['json-patch', 'JSON Patch & Merge Patch'],
      ['json-write', 'Write operations'],
      ['jsonpath', 'JSONPath'],
      ['json-query', 'Jaren JSON Query'],
      ['jslt', 'JSLT stylesheets'],
      ['xquery', 'XQuery front-end'],
    ],
  },
  {
    title: 'More packages',
    items: [
      ['formats', '@jarenjs/formats'],
      ['forms', '@jarenjs/forms'],
      ['core-refs', 'core & refs'],
      ['josl', 'JOSL & JSONX (research)'],
      ['further-reading', 'Further reading'],
    ],
  },
];

/**
 * Sidebar link that scrolls to a section. A plain `href="#id"` anchor
 * would be swallowed by the HashRouter (it reads `#id` as a route), so
 * scroll imperatively and leave the URL alone.
 */
function scrollToSection(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function SectionHeading({ id, children, pkg }) {
  return (
    <div className="flex items-center gap-3 mb-4 scroll-mt-20" id={id}>
      <h2 className="text-2xl font-bold">{children}</h2>
      {pkg && <Badge variant="outline" className="font-mono text-xs">{pkg}</Badge>}
    </div>
  );
}

function Documentation() {
  return (
    <div className="py-8">
      <Container>
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Documentation</h1>
          <p className="text-muted-foreground max-w-3xl">
            The whole toolchain in one pass — validation, addressing, queries, stylesheets and forms.
            Each section links the deeper specification in the repository.
          </p>
        </div>

        <div className="grid lg:grid-cols-4 gap-8">
          {/* Sidebar */}
          <div className="hidden lg:block space-y-6 sticky top-20 self-start">
            {NAV.map((group) => (
              <div key={group.title}>
                <h3 className="font-semibold mb-3 text-sm">{group.title}</h3>
                <ul className="space-y-2 text-sm">
                  {group.items.map(([id, label]) => (
                    <li key={id}>
                      <button
                        onClick={() => scrollToSection(id)}
                        className="text-muted-foreground hover:text-primary text-left"
                      >
                        {label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {/* Main */}
          <div className="lg:col-span-3 space-y-14">
            <section>
              <SectionHeading id="installation">Installation</SectionHeading>
              <p className="text-muted-foreground mb-4">
                Install what you need — the packages are a dependency chain, not a bundle:
              </p>
              <div className="space-y-3">
                <CodeBlock showCopy>{`# JSON Schema validation with formats
npm install @jarenjs/validate @jarenjs/formats

# pointers, JSONPath, the query language, JSLT, the XQuery front-end
npm install @jarenjs/json

# framework-agnostic form generation
npm install @jarenjs/forms`}</CodeBlock>
              </div>
              <p className="text-sm text-muted-foreground mt-3">
                Everything is ESM, zero-dependency, <code className="bg-muted px-1 rounded">eval</code>-free and CSP-safe.
              </p>
            </section>

            <section>
              <SectionHeading id="quick-start">Quick start</SectionHeading>
              <CodeBlock showCopy>{basicExample}</CodeBlock>
            </section>

            <section>
              <SectionHeading id="validation-options" pkg="@jarenjs/validate">Options</SectionHeading>
              <Card>
                <CardContent className="pt-6">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2">Option</th>
                        <th className="text-left py-2">Default</th>
                        <th className="text-left py-2">Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b">
                        <td className="py-2 font-mono text-xs">collectErrors</td>
                        <td className="py-2">false</td>
                        <td className="py-2 text-muted-foreground">Return <code className="bg-muted px-1 rounded">{'{ valid, errors }'}</code> instead of a boolean</td>
                      </tr>
                      <tr className="border-b">
                        <td className="py-2 font-mono text-xs">skipErrors</td>
                        <td className="py-2">true</td>
                        <td className="py-2 text-muted-foreground">Stop at the first error (set false to gather all)</td>
                      </tr>
                      <tr className="border-b">
                        <td className="py-2 font-mono text-xs">formatAssertion</td>
                        <td className="py-2">per draft</td>
                        <td className="py-2 text-muted-foreground">Assert <code className="bg-muted px-1 rounded">format</code> even where the draft makes it annotation-only</td>
                      </tr>
                      <tr>
                        <td className="py-2 font-mono text-xs">useGrapheme</td>
                        <td className="py-2">true</td>
                        <td className="py-2 text-muted-foreground">Grapheme-cluster string lengths (what a human calls a character)</td>
                      </tr>
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </section>

            <section>
              <SectionHeading id="error-handling" pkg="@jarenjs/validate">Error handling</SectionHeading>
              <CodeBlock showCopy>{errorCollectionExample}</CodeBlock>
            </section>

            <section>
              <SectionHeading id="refs" pkg="@jarenjs/validate">$ref resolution</SectionHeading>
              <p className="text-muted-foreground mb-4">
                Full reference support across all drafts: <code className="bg-muted px-1 rounded">$ref</code>,{' '}
                <code className="bg-muted px-1 rounded">$id</code>, <code className="bg-muted px-1 rounded">$anchor</code>,{' '}
                <code className="bg-muted px-1 rounded">$recursiveRef</code>/<code className="bg-muted px-1 rounded">$recursiveAnchor</code>{' '}
                (2019-09) and <code className="bg-muted px-1 rounded">$dynamicRef</code>/<code className="bg-muted px-1 rounded">$dynamicAnchor</code>{' '}
                (2020-12), with per-document draft handling and <code className="bg-muted px-1 rounded">$vocabulary</code> processing.
              </p>
              <CodeBlock showCopy>{refExample}</CodeBlock>
            </section>

            <section>
              <SectionHeading id="query-keyword" pkg="@jarenjs/validate">The $query keyword</SectionHeading>
              <p className="text-muted-foreground mb-4">
                Cross-field constraints — sums, date ordering, quantification — are the class of assertion JSON Schema
                is notoriously bad at. The <code className="bg-muted px-1 rounded">$query</code> extension keyword embeds
                a Jaren JSON Query, compiled once with the schema and asserted per validation. Runtime query errors are
                validation failures with a <code className="bg-muted px-1 rounded">code</code> and{' '}
                <code className="bg-muted px-1 rounded">docPath</code>, never throws.
              </p>
              <CodeBlock showCopy>{queryKeywordExample}</CodeBlock>
            </section>

            <section>
              <SectionHeading id="draft-support" pkg="@jarenjs/validate">Draft support</SectionHeading>
              <DraftSupport />
            </section>

            <section>
              <SectionHeading id="json-pointer" pkg="@jarenjs/json">JSON Pointer</SectionHeading>
              <p className="text-muted-foreground mb-4">
                RFC 6901 plus relative pointers, as a two-stage compiler: strict single-pass parsers feed getters
                specialized by segment count. Resolution allocates nothing; misses return the{' '}
                <code className="bg-muted px-1 rounded">JSONPOINTER_NOTHING</code> sentinel.
              </p>
              <CodeBlock showCopy>{pointerExample}</CodeBlock>
            </section>

            <section>
              <SectionHeading id="json-patch" pkg="@jarenjs/json">JSON Patch & Merge Patch</SectionHeading>
              <p className="text-muted-foreground mb-4">
                Partial updates as IETF standards, on the compiled-pointer foundation. JSON Patch (RFC 6902) is the
                precise, operation-based format — <code className="bg-muted px-1 rounded">add</code>,{' '}
                <code className="bg-muted px-1 rounded">remove</code>, <code className="bg-muted px-1 rounded">replace</code>,{' '}
                <code className="bg-muted px-1 rounded">move</code>, <code className="bg-muted px-1 rounded">copy</code> and the{' '}
                <code className="bg-muted px-1 rounded">test</code> precondition for optimistic concurrency — ideal for HTTP{' '}
                <code className="bg-muted px-1 rounded">PATCH</code> endpoints and array surgery. JSON Merge Patch (RFC 7396)
                is the simple, document-shaped format: the patch looks like the document, <code className="bg-muted px-1 rounded">null</code>{' '}
                deletes. <code className="bg-muted px-1 rounded">compileJSONPatch</code> validates the patch once and applies it{' '}
                <em>copy-on-write</em>: the input is never mutated, only the written spine is cloned (once, however many
                operations touch it), everything else is shared with the result — so atomic abort on failure is free, exactly
                as RFC 6902 §5 requires. The diffs (<code className="bg-muted px-1 rounded">createJSONPatch</code>,{' '}
                <code className="bg-muted px-1 rounded">createMergePatch</code>) turn two documents into either format — a
                ready-made change feed. All 108 official json-patch-tests vectors pass; errors carry a stable{' '}
                <code className="bg-muted px-1 rounded">code</code>, a <code className="bg-muted px-1 rounded">docPath</code> into
                the patch and a <code className="bg-muted px-1 rounded">dataPath</code> into the document.
              </p>
              <CodeBlock showCopy>{patchExample}</CodeBlock>
            </section>

            <section>
              <SectionHeading id="json-write" pkg="@jarenjs/json">Write operations</SectionHeading>
              <p className="text-muted-foreground mb-4">
                When a whole patch document is more ceremony than the job needs: standalone{' '}
                <code className="bg-muted px-1 rounded">set</code> / <code className="bg-muted px-1 rounded">insert</code> /{' '}
                <code className="bg-muted px-1 rounded">remove</code>, compiled once per target on the same copy-on-write
                core. A target is an RFC 6901 pointer, an RFC 9535 normalized path, or <em>any</em> singular JSONPath
                query — including negative (from-the-end) indexes and <code className="bg-muted px-1 rounded">/arr/-</code>{' '}
                append. The <code className="bg-muted px-1 rounded">compileJSONPath*</code> variants write at{' '}
                <em>every</em> node an arbitrary query selects, applying matched locations in reverse document order so
                multiple removals or inserts in one array — and nested matches — compose without index bookkeeping.
                Setters accept updater functions; failures (<code className="bg-muted px-1 rounded">JsonWriteError</code>,
                stable codes, target as <code className="bg-muted px-1 rounded">dataPath</code>) leave the input
                untouched, and <code className="bg-muted px-1 rounded">{'{ mutate: true }'}</code> patches in place.
              </p>
              <CodeBlock showCopy>{writeExample}</CodeBlock>
            </section>

            <section>
              <SectionHeading id="jsonpath" pkg="@jarenjs/json">JSONPath</SectionHeading>
              <p className="text-muted-foreground mb-4">
                The complete RFC 9535 grammar — all 703 tests of the official compliance suite pass, normalized paths
                included. Filters use I-Regexp (RFC 9485) for <code className="bg-muted px-1 rounded">match()</code>/<code className="bg-muted px-1 rounded">search()</code>.
              </p>
              <CodeBlock showCopy>{pathExample}</CodeBlock>
            </section>

            <section>
              <SectionHeading id="json-query" pkg="@jarenjs/json">Jaren JSON Query</SectionHeading>
              <p className="text-muted-foreground mb-4">
                XQuery 3.1 semantics — FLWOR phrases, joins, grouping, ordering, quantifiers, a 58-operator library —
                written as JSON documents with JSONPath leaves. The grammar is published as a JSON Schema (2020-12 +
                draft-07 twin) so queries can be validated, stored, and generated by constrained LLM decoding. Errors
                carry a stable code and a <code className="bg-muted px-1 rounded">docPath</code> JSON Pointer into the query document.
              </p>
              <CodeBlock showCopy>{queryExample}</CodeBlock>
              <p className="text-sm text-muted-foreground mt-3">
                Full language contract:{' '}
                <a className="underline inline-flex items-center gap-1" href={`${REPO}/blob/main/packages/json/docs/QUERY-FORMAT.md`} target="_blank" rel="noopener noreferrer">
                  QUERY-FORMAT.md <ExternalLink className="h-3 w-3" />
                </a>
              </p>
            </section>

            <section>
              <SectionHeading id="jslt" pkg="@jarenjs/json">JSLT stylesheets</SectionHeading>
              <p className="text-muted-foreground mb-4">
                The recursive stylesheet layer — XSLT&apos;s template dispatch with JSON&apos;s pieces. Rules match by
                JSONPath (position) and/or JSON Schema (shape); bodies are query documents; ranked priorities, template
                modes and <code className="bg-muted px-1 rounded">share</code>/<code className="bg-muted px-1 rounded">fresh</code>/<code className="bg-muted px-1 rounded">error</code>{' '}
                dispositions control everything the rules don&apos;t rewrite. Unchanged subtrees are shared by identity,
                and a transform that changes nothing returns the input reference.
              </p>
              <CodeBlock showCopy>{jsltExample}</CodeBlock>
              <p className="text-sm text-muted-foreground mt-3">
                Full language contract:{' '}
                <a className="underline inline-flex items-center gap-1" href={`${REPO}/blob/main/packages/json/docs/JSLT-FORMAT.md`} target="_blank" rel="noopener noreferrer">
                  JSLT-FORMAT.md <ExternalLink className="h-3 w-3" />
                </a>
              </p>
            </section>

            <section>
              <SectionHeading id="xquery" pkg="@jarenjs/json">XQuery front-end</SectionHeading>
              <p className="text-muted-foreground mb-4">
                A strict recursive-descent parser for a documented XQuery 3.1 subset that emits Jaren query documents —
                the bridge that runs the W3C QT3 suite (31,821 cases, zero unattributed failures). Anything outside the
                subset fails with a named <code className="bg-muted px-1 rounded">unsupported construct</code> error.
              </p>
              <CodeBlock showCopy>{xqueryExample}</CodeBlock>
            </section>

            <section>
              <SectionHeading id="formats" pkg="@jarenjs/formats">Format validators</SectionHeading>
              <p className="text-muted-foreground mb-4">
                All standard string formats plus many extras, numeric range formats, and the JSON addressing formats —
                <code className="bg-muted px-1 rounded">json-path</code> is checked against the complete RFC 9535 grammar
                by the real parser. One canonical name → predicate registry backs both the validator&apos;s compilers and
                forms&apos; per-keystroke testers, so the two can never drift.
              </p>
              <CodeBlock showCopy>{formatsExample}</CodeBlock>
              <div className="grid sm:grid-cols-2 gap-4 mt-4">
                <Card>
                  <CardContent className="pt-4">
                    <p className="text-sm font-medium mb-2">String & i18n</p>
                    <div className="flex flex-wrap gap-1">
                      {['email', 'idn-email', 'hostname', 'idn-hostname', 'ipv4', 'ipv6', 'uri', 'iri', 'uuid', 'uri-template', 'regex', 'iban', 'isbn10', 'isbn13', 'mac', 'color', 'alpha', 'base64', '…'].map((f) => (
                        <Badge key={f} variant="secondary" className="text-xs">{f}</Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-4">
                    <p className="text-sm font-medium mb-2">Date-time, numbers & JSON</p>
                    <div className="flex flex-wrap gap-1">
                      {['date-time', 'date', 'time', 'duration', 'int8…uint64', 'float16…float64', 'json-pointer', 'relative-json-pointer', 'json-path', '…'].map((f) => (
                        <Badge key={f} variant="secondary" className="text-xs">{f}</Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </section>

            <section>
              <SectionHeading id="forms" pkg="@jarenjs/forms">Form generation</SectionHeading>
              <p className="text-muted-foreground mb-4">
                Turns a schema into a framework-agnostic form model, with validation in three layers on one stack:
                per-field on every keystroke (shared format registry), cross-field on every keystroke
                (<code className="bg-muted px-1 rounded">x-form</code> rules written as query documents), and
                authoritative on submit (the compiled schema — optionally with the same rules copied into a{' '}
                <code className="bg-muted px-1 rounded">$query</code> keyword). The{' '}
                <Link className="underline" to="/playground">playground&apos;s</Link> Generated Form tab runs on it.
              </p>
              <CodeBlock showCopy>{formsExample}</CodeBlock>
            </section>

            <section>
              <SectionHeading id="core-refs">core & refs</SectionHeading>
              <p className="text-muted-foreground">
                <code className="bg-muted px-1 rounded">@jarenjs/core</code> is the zero-dependency foundation every
                package builds on — type guards, grapheme-aware Unicode strings, the text-validation toolbox, RFC 3339
                dates, integer/float range checks, char-code scanner kits and asm.js-style math. Every module works
                standalone. <code className="bg-muted px-1 rounded">@jarenjs/refs</code> bundles the official JSON Schema
                meta-schemas for all supported drafts so draft detection and meta-validation work offline.
              </p>
            </section>

            <section>
              <SectionHeading id="josl" pkg="@jarenjs/josl">JOSL & JSONX (research)</SectionHeading>
              <p className="text-muted-foreground mb-4">
                A research experiment, unpublished: <strong>JOSL</strong> is a strict TOML 1.0 superset that makes
                JavaScript&apos;s obvious value types first-class — <code className="bg-muted px-1 rounded">null</code>,
                bigint, regexp, all four TOML datetime flavours — and adds a streamable{' '}
                <code className="bg-muted px-1 rounded">[[]]</code> root array for LLM record streams.{' '}
                <strong>JSONX</strong> is the same set of extensions over JSON with a bit-compatible strict mode.
                Strict TOML mode passes the complete official toml-test 1.0.0 suite — see the{' '}
                <Link className="underline" to="/benchmarks?suite=toml">benchmark</Link> and the{' '}
                <Link className="underline" to="/playground?engine=josl">playground</Link>.
              </p>
              <CodeBlock showCopy>{joslExample}</CodeBlock>
            </section>

            <section>
              <SectionHeading id="further-reading">Further reading</SectionHeading>
              <ul className="space-y-2 text-sm">
                {[
                  ['HOWTO.md', 'HOWTO.md', 'installation profiles, options, custom formats, performance tips, pitfalls'],
                  ['ARCHITECTURE.md', 'ARCHITECTURE.md', 'how the monorepo fits together; the compile-to-closures design'],
                  ['benchmark/README.md', 'benchmark/README.md', 'every conformance & performance claim, reproducible'],
                  ['packages/json/docs/QUERY-FORMAT.md', 'QUERY-FORMAT.md', 'the Jaren JSON Query language specification'],
                  ['packages/json/docs/JSLT-FORMAT.md', 'JSLT-FORMAT.md', 'the JSLT stylesheet specification'],
                  ['packages/json/docs/XQUERY-FRONTEND.md', 'XQUERY-FRONTEND.md', 'the XQuery text subset and its mapping'],
                  ['packages/josl/FORMAT.md', 'JOSL FORMAT.md', 'the JOSL/JSONX language definition and design rationale'],
                  ['ROADMAP.md', 'ROADMAP.md', 'release milestones and everything still to come'],
                ].map(([path, label, blurb]) => (
                  <li key={path} className="flex items-start gap-2">
                    <ExternalLink className="h-3.5 w-3.5 mt-1 shrink-0 text-muted-foreground" />
                    <span>
                      <a className="font-medium underline" href={`${REPO}/blob/main/${path}`} target="_blank" rel="noopener noreferrer">{label}</a>
                      <span className="text-muted-foreground"> — {blurb}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </div>
      </Container>
    </div>
  );
}

export { Documentation };
