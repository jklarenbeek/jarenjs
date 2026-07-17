import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Container } from '@components/layout/Container';
import { Button } from '@components/ui/button';
import { CodeBlock } from '@components/ui/code-block';
import { Badge } from '@components/ui/badge';
import { Card, CardContent } from '@components/ui/card';
import { cn } from '@lib/utils';
import {
  ShieldCheck,
  Zap,
  Braces,
  ArrowRight,
  Play,
  BookOpen,
  BarChart3,
  Bot,
  Wrench,
  Lock,
  FileJson2,
  Github,
} from 'lucide-react';

/* ------------------------------------------------------------------ */
/* The engine showcase: one tab per engine, real code, real numbers.  */
/* ------------------------------------------------------------------ */

const ENGINES = [
  {
    key: 'validate',
    label: 'Validate',
    title: 'JSON Schema, compiled',
    perf: '100% of the official suite · faster than Ajv on most tests',
    playground: '/playground',
    benchmarks: '/benchmarks?suite=validate',
    code: `import { JarenValidator } from '@jarenjs/validate';

const validate = new JarenValidator().compile({
  type: 'object',
  properties: {
    lines: { type: 'array', items: { $ref: '#/$defs/line' } },
    total: { type: 'number' },
  },
  // cross-field assertion: a query INSIDE the schema
  $query: { $eq: ['$.total', { $sum: '$.lines[*].amount' }] },
  $defs: {
    line: {
      type: 'object',
      properties: { amount: { type: 'number' } },
      required: ['amount'],
    },
  },
});

// true:
validate({ lines: [{ amount: 30 }, { amount: 20 }], total: 50 });
// false — the sum doesn't match:
validate({ lines: [{ amount: 30 }], total: 50 });`,
    blurb: 'Draft-06 through 2020-12, unevaluated*, $dynamicRef, $vocabulary, $data — and the $query keyword for the cross-field constraints (sums, ordering, quantification) JSON Schema is notoriously bad at.',
  },
  {
    key: 'path',
    label: 'JSONPath',
    title: 'RFC 9535, compiled to closures',
    perf: '703/703 compliance tests · 18x faster than json-p3 on the CTS mean',
    playground: '/playground?engine=jsonpath',
    benchmarks: '/benchmarks?suite=jsonpath',
    code: `import { compileJSONPath } from '@jarenjs/json';

const query = compileJSONPath('$.store.book[?@.price < 10].title');

query(data);        // ['Sayings of the Century', 'Moby Dick']
query.paths(data);  // ["$['store']['book'][0]['title']", ...]
query.nodes(data);  // both, as { values, paths }`,
    blurb: 'The complete RFC 9535 grammar — filters, slices, descendants, I-Regexp match()/search() — parsed once into specialized closures. Normalized paths included.',
  },
  {
    key: 'pointer',
    label: 'Pointer',
    title: 'RFC 6901 + relative pointers',
    perf: '12–16x faster than interpretive resolution · zero allocation',
    playground: '/playground?engine=pointer',
    benchmarks: '/benchmarks?suite=jsonpointer',
    code: `import {
  compileJSONPointer,
  compileRelativeJSONPointer,
  JSONPOINTER_NOTHING,
} from '@jarenjs/json';

const price = compileJSONPointer('/store/book/0/price');
price(data); // 8.95 — unrolled hops, names pre-decoded

// the $data hot path: "up one, then down /maxQty"
const maxQty = compileRelativeJSONPointer('1/maxQty');
maxQty(data, '/order/lines/13/qty'); // 10

price({}) === JSONPOINTER_NOTHING; // misses are a sentinel, not a throw`,
    blurb: 'Pointers compile to getters specialized by segment count. Misses return a shared sentinel — the zero-allocation path the validator’s $data keyword runs per instance.',
  },
  {
    key: 'patch',
    label: 'Patch',
    title: 'RFC 6902 + Merge Patch, copy-on-write',
    perf: '108/108 official vectors · 5–170x vs clone-and-interpret',
    playground: '/playground?engine=patch',
    benchmarks: '/benchmarks?suite=jsonpatch',
    code: `import {
  compileJSONPatch,
  createJSONPatch,
  applyMergePatch,
} from '@jarenjs/json';

// compile once — every pointer parsed, every op a closure
const apply = compileJSONPatch([
  { op: 'test', path: '/version', value: 5 },
  { op: 'replace', path: '/user/name', value: 'Bob' },
  { op: 'add', path: '/user/tags/-', value: 'admin' },
]);

const next = apply(doc);
// doc is untouched: only the written spine is cloned, the rest
// is SHARED — and a failing op aborts atomically (RFC 6902 §5)

createJSONPatch(doc, next); // the diff writes the patch for you
applyMergePatch(doc, { user: { name: 'Bob' }, temp: null });`,
    blurb: 'Partial updates as standards: JSON Patch (RFC 6902) and JSON Merge Patch (RFC 7396), applied copy-on-write so the input is never touched and atomic abort costs nothing. Structural diffs emit either format — a ready-made change feed for forms, HTTP PATCH endpoints and optimistic concurrency.',
  },
  {
    key: 'query',
    label: 'Query',
    title: 'XQuery 3.1 semantics, JSON syntax',
    perf: '14–215x vs fontoxpath · 10–63x vs JSONata',
    playground: '/playground?engine=query',
    benchmarks: '/benchmarks?suite=jsonquery',
    code: `import { compileJsonQuery } from '@jarenjs/json';

// FLWOR: for / where / group by / order by / return — as JSON
const perGenre = compileJsonQuery({
  $for: { b: '$.store.book[*]' },
  $groupby: { genre: '$b.category' },
  $return: {
    genre: '$genre',
    count: { $count: '$b' },
    avg: { $avg: '$b.price' },
  },
});

perGenre(data);
// [{ genre: 'reference', count: 1, avg: 8.95 },
//  { genre: 'fiction',   count: 3, avg: 14.99 }]`,
    blurb: 'FLWOR phrases, joins, quantifiers, 58 operators, external parameters — queries are data: validate them with the published JSON Schema, generate them with an LLM, embed them in schemas.',
  },
  {
    key: 'jslt',
    label: 'JSLT',
    title: 'Stylesheets for JSON',
    perf: 'identity in 24–81 ns at any size · 6.6–45x vs JSONata transforms',
    playground: '/playground?engine=jslt',
    benchmarks: '/benchmarks?suite=jslt',
    code: `import { transformJson } from '@jarenjs/json/jslt';

// XSLT's recursive dispatch, JSON's pieces: match by JSONPath
// (position) or JSON Schema (shape), produce with query documents.
const withVat = transformJson(
  [{ match: '$..price', body: { $mul: ['$', 1.21] } }],
  data);

// everything off the matched spine is SHARED, not copied —
// and a transform that changes nothing returns the input itself:
transformJson([], data) === data; // true, in nanoseconds`,
    blurb: 'Ranked rules, template modes, share/fresh/error dispositions, and proof-of-no-change sharing: unchanged subtrees keep their identity instead of being deep-copied.',
  },
  {
    key: 'jtlt',
    label: 'JTLT',
    title: 'Templates for text output',
    perf: 'the JSLT dispatcher aimed at text · zero new operators',
    playground: '/playground?engine=jtlt',
    benchmarks: '/benchmarks',
    code: `import { renderText } from '@jarenjs/json/jtlt';

// JSLT rules whose bodies are text segments: literal strings,
// interpolated queries, $apply splices — XSLT method="text"
// with T4's ergonomics, written as JSON.
renderText([
  { match: '$', body: ['# Books\\n', { $apply: '$.store.book[*]' }] },
  { match: '$.store.book[*]',
    body: ['- ', '$.title', ' (', '$.price', ')\\n'] },
], data);
// '# Books
//  - Sayings of the Century (8.95)
//  - Sword of Honour (12.99)  ...'

// "output": "xml" escapes interpolated data — literal markup
// stays raw, exactly the XSLT/T4 contract`,
    blurb: 'A JTLT template compiles down to an ordinary JSLT stylesheet — dispatch, modes, priorities and schema matching inherited, the compiled stylesheet inspectable — then a writer serializes the result as raw text or escaped XML. Markdown, config files, code: JSON in, string out.',
  },
  {
    key: 'xquery',
    label: 'XQuery',
    title: 'A real XQuery front-end',
    perf: '31,821 W3C QT3 cases · 0 unattributed failures',
    playground: '/playground?engine=xquery',
    benchmarks: '/benchmarks',
    code: `import { parseXQuery } from '@jarenjs/json/xquery';

const doc = parseXQuery(\`
  for $b in $doc?store?book?*
  where $b?price < 10
  order by $b?price
  return map { "title": $b?title }
\`);
// -> the equivalent Jaren query document (plain JSON):
// { $for: { b: '$doc.store.book[*]' },
//   $where: { $lt: ['$b.price', 10] }, ... }`,
    blurb: 'Type XQuery, get a query document. The same parser faces the W3C QT3 suite — every failure attributed to a documented deviation, none unexplained.',
  },
  {
    key: 'forms',
    label: 'Forms',
    title: 'Schemas that render themselves',
    perf: 'framework-agnostic · three validation layers on one stack',
    playground: '/playground',
    benchmarks: '/benchmarks',
    code: `import { buildFormModel, compileFormRules } from '@jarenjs/forms';

const model = buildFormModel(schema);   // field tree: labels, controls,
                                        // constraints, enum options
const rules = compileFormRules(model);  // x-form: visibility, computed
                                        // values, cross-field asserts —
                                        // written as query documents

// per-field on every keystroke, cross-field on every keystroke,
// authoritative on submit — the same rules, one engine.`,
    blurb: 'A JSON Schema becomes a form model for React, Vue or vanilla DOM. x-form rules (visibility, enablement, computed values, assertions) are query documents — written once, enforced per keystroke and on submit.',
  },
];

function EngineShowcase() {
  const [active, setActive] = useState('validate');
  const engine = ENGINES.find((e) => e.key === active);

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-6">
        {ENGINES.map((e) => (
          <button
            key={e.key}
            onClick={() => setActive(e.key)}
            className={cn(
              'px-4 py-2 rounded-lg text-sm font-medium transition-all',
              active === e.key
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'bg-muted text-muted-foreground hover:bg-muted/70',
            )}
          >
            {e.label}
          </button>
        ))}
      </div>

      <div className="grid lg:grid-cols-2 gap-8 items-start">
        <div>
          <h3 className="text-2xl font-bold mb-2">{engine.title}</h3>
          <Badge variant="secondary" className="mb-4 font-mono text-xs">{engine.perf}</Badge>
          <p className="text-muted-foreground mb-6">{engine.blurb}</p>
          <div className="flex flex-wrap gap-3">
            <Link to={engine.playground}>
              <Button className="gap-2">
                <Play className="h-4 w-4" />
                Try it live
              </Button>
            </Link>
            <Link to={engine.benchmarks}>
              <Button variant="outline" className="gap-2">
                <BarChart3 className="h-4 w-4" />
                See the numbers
              </Button>
            </Link>
          </div>
        </div>
        <CodeBlock showCopy>{engine.code}</CodeBlock>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

const PACKAGES = [
  {
    name: '@jarenjs/core',
    description: 'Zero-dependency foundation: type guards, grapheme-aware Unicode, text validators (email, IBAN, IRI, I-Regexp…), RFC 3339 dates, int/float ranges, char-code scanners.',
  },
  {
    name: '@jarenjs/json',
    description: 'The addressing & transformation stack: JSON Pointer, JSON Patch & Merge Patch, JSONPath (RFC 9535), the Jaren JSON Query language, JSLT stylesheets, JTLT text templates, and the XQuery text front-end.',
  },
  {
    name: '@jarenjs/validate',
    description: 'The JSON Schema validating compiler — draft-06 → 2020-12, unevaluated*, dynamic refs, $vocabulary, $data, and the $query extension keyword.',
  },
  {
    name: '@jarenjs/formats',
    description: 'Every standard format (date-time, email, idn-hostname, uuid…) plus extras (iban, isbn10, mac, color…), numeric formats, and the JSON addressing formats.',
  },
  {
    name: '@jarenjs/refs',
    description: 'The official meta-schemas for all supported drafts, bundled — draft detection, $vocabulary processing and meta-validation work offline.',
  },
  {
    name: '@jarenjs/forms',
    description: 'Framework-agnostic form generation: schema → field-descriptor tree, with per-keystroke validation and query-powered x-form rules.',
  },
];

const AI_POINTS = [
  {
    icon: ShieldCheck,
    title: 'Validate what the model produced',
    text: 'Provider structured-output modes enforce varying schema subsets. A validator that passes 100% of the official suite sits between the model and your program — compiled once, sub-microsecond per generation, inside the agent loop.',
  },
  {
    icon: Braces,
    title: 'A whole language as a closed vocabulary',
    text: 'The query and JSLT grammars are published as JSON Schemas (2020-12 + draft-07 twins). Hand one to a constrained decoder and the model cannot emit an unknown operator or a wrong arity — it generates programs that are data.',
  },
  {
    icon: Wrench,
    title: 'Every failure is machine-repairable',
    text: 'Compile and runtime errors carry a stable code and a docPath — a JSON Pointer into the offending document — plus "did you mean" suggestions. Exactly the feedback shape an LLM repair loop needs.',
  },
  {
    icon: Lock,
    title: 'Runs anywhere an agent runs',
    text: 'No eval, no new Function, no runtime dependencies. Every compiler is CSP-safe and sandbox-friendly by construction — this playground runs them all in your browser.',
  },
];

function Home() {
  return (
    <div>
      {/* Hero */}
      <section className="py-20 lg:py-28 bg-gradient-to-b from-background to-muted/30">
        <Container>
          <div className="text-center max-w-4xl mx-auto">
            <div className="flex justify-center mb-6">
              <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-primary text-primary-foreground font-bold text-4xl shadow-lg">
                J
              </div>
            </div>

            <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-6">
              JSON, all the way down
            </h1>

            <p className="text-xl md:text-2xl text-muted-foreground mb-4 text-balance">
              Jaren is a high-performance JSON toolchain: a schema validating compiler with
              pointers, JSONPath, an XQuery-class query language, stylesheets, text templates and form generation around it.
            </p>
            <p className="text-muted-foreground mb-10">
              One philosophy everywhere: <strong className="text-foreground">parse and decide everything once at compile time,
              then run a specialized closure.</strong> That is where the speed comes from.
            </p>

            <div className="flex flex-wrap justify-center gap-4 mb-12">
              <Link to="/playground">
                <Button size="lg" className="gap-2">
                  <Play className="h-4 w-4" />
                  Open the Playground
                </Button>
              </Link>
              <Link to="/benchmarks">
                <Button size="lg" variant="outline" className="gap-2">
                  <BarChart3 className="h-4 w-4" />
                  Benchmarks
                </Button>
              </Link>
              <Link to="/docs">
                <Button size="lg" variant="outline" className="gap-2">
                  <BookOpen className="h-4 w-4" />
                  Documentation
                </Button>
              </Link>
            </div>

            {/* Proof strip — conformance before speed */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-left">
              {[
                {
                  big: '100%',
                  label: 'of the official JSON-Schema-Test-Suite — draft-07, 2019-09 & 2020-12, optional formats included',
                },
                { big: '703/703', label: 'JSONPath Compliance Test Suite (RFC 9535), normalized paths included' },
                { big: '0', label: 'unattributed failures across 31,821 W3C QT3 XQuery/XPath cases' },
                { big: '0 deps', label: 'zero runtime dependencies, no eval, CSP-safe — MIT licensed' },
              ].map((item) => (
                <div key={item.big} className="rounded-xl border bg-card p-4">
                  <p className="text-2xl font-bold text-primary">{item.big}</p>
                  <p className="text-xs text-muted-foreground mt-1">{item.label}</p>
                </div>
              ))}
            </div>
          </div>
        </Container>
      </section>

      {/* Quick install */}
      <section className="py-12 border-y bg-muted/30">
        <Container>
          <div className="max-w-2xl mx-auto">
            <h2 className="text-center text-sm font-medium text-muted-foreground mb-4 uppercase tracking-wider">
              Quick start
            </h2>
            <CodeBlock showCopy>npm install @jarenjs/validate @jarenjs/formats @jarenjs/json</CodeBlock>
          </div>
        </Container>
      </section>

      {/* Engine showcase */}
      <section className="py-20">
        <Container>
          <div className="text-center mb-10">
            <h2 className="text-3xl font-bold mb-3">Nine tools, one stack</h2>
            <p className="text-muted-foreground max-w-2xl mx-auto">
              Each layer is a compiler over the same primitives — pointers feed the validator,
              JSONPath feeds the query language, queries power stylesheets, templates, schemas and forms.
            </p>
          </div>
          <EngineShowcase />
        </Container>
      </section>

      {/* Speed section */}
      <section className="py-20 bg-muted/30">
        <Container>
          <div className="grid md:grid-cols-2 gap-10 items-center">
            <div>
              <h2 className="text-3xl font-bold mb-4 flex items-center gap-2">
                <Zap className="h-7 w-7 text-primary" />
                Measured, not claimed
              </h2>
              <p className="text-muted-foreground mb-4">
                Every number is reproducible from the repository&apos;s benchmark workspace, against the strongest
                competitor on each turf — and correctness is asserted before a single nanosecond is measured.
                The benchmark page lets you drill into <em>every individual test</em> to see exactly where Jaren
                is faster and where it is not.
              </p>
              <Link to="/benchmarks">
                <Button variant="outline" className="gap-2">
                  Explore the drill-down
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </Link>
            </div>
            <div className="space-y-3">
              {[
                { label: 'JSON Schema validation', vs: 'vs Ajv', num: 'faster on the majority of suite tests, 100% conformant' },
                { label: 'JSONPath (RFC 9535)', vs: 'vs json-p3', num: '18.7x faster on the CTS mean' },
                { label: 'JSON Query', vs: 'vs fontoxpath / JSONata', num: '14–215x / 10–63x faster' },
                { label: 'JSLT identity', vs: 'vs deep-copying engines', num: 'nanoseconds at any document size' },
                { label: 'JSON Pointer', vs: 'vs interpretive resolution', num: '12–16x faster, zero allocation' },
                { label: 'JSON Patch & Merge Patch', vs: 'vs clone-and-interpret patching', num: '5–170x faster, atomic for free' },
              ].map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-4 rounded-lg border bg-card px-4 py-3">
                  <div>
                    <p className="text-sm font-medium">{row.label}</p>
                    <p className="text-xs text-muted-foreground">{row.vs}</p>
                  </div>
                  <p className="text-sm font-mono font-semibold text-[var(--viz-faster)] text-right">{row.num}</p>
                </div>
              ))}
            </div>
          </div>
        </Container>
      </section>

      {/* AI section */}
      <section className="py-20">
        <Container>
          <div className="text-center mb-10">
            <h2 className="text-3xl font-bold mb-3 flex items-center justify-center gap-2">
              <Bot className="h-7 w-7 text-primary" />
              Built for the LLM era
            </h2>
            <p className="text-muted-foreground max-w-3xl mx-auto">
              JSON Schema is the lingua franca of the LLM ecosystem — tool definitions are schemas, structured output
              is constrained by them. Jaren is the infrastructure on the receiving end: to work with language models
              naturally, speak JSON all the way down.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 gap-6">
            {AI_POINTS.map((point) => (
              <Card key={point.title}>
                <CardContent className="pt-6">
                  <point.icon className="h-6 w-6 text-primary mb-3" />
                  <h3 className="font-semibold mb-2">{point.title}</h3>
                  <p className="text-sm text-muted-foreground">{point.text}</p>
                </CardContent>
              </Card>
            ))}
          </div>
        </Container>
      </section>

      {/* Packages */}
      <section className="py-20 bg-muted/30">
        <Container>
          <div className="text-center mb-10">
            <h2 className="text-3xl font-bold mb-3">The packages</h2>
            <p className="text-muted-foreground max-w-2xl mx-auto">
              A monorepo organized as a dependency chain — each package builds on the ones before it.
              Use only what you need; every module works standalone.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {PACKAGES.map((pkg) => (
              <a
                key={pkg.name}
                href={`https://github.com/jklarenbeek/jarenjs/tree/main/packages/${pkg.name.split('/')[1]}`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-xl border bg-card p-5 hover:border-primary/50 hover:shadow-sm transition-all group"
              >
                <div className="flex items-center justify-between mb-2">
                  <p className="font-mono text-sm font-semibold text-primary">{pkg.name}</p>
                  <FileJson2 className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
                </div>
                <p className="text-sm text-muted-foreground">{pkg.description}</p>
              </a>
            ))}
          </div>
        </Container>
      </section>

      {/* CTA */}
      <section className="py-20 bg-primary text-primary-foreground">
        <Container>
          <div className="text-center max-w-2xl mx-auto">
            <h2 className="text-3xl font-bold mb-4">See it run</h2>
            <p className="text-primary-foreground/80 mb-8">
              Every compiler in this suite runs live in your browser — validate a schema, patch a document and
              diff it back, join two arrays with a query, transform a document with a stylesheet, render it to
              Markdown with a template, or type XQuery and watch it become JSON.
            </p>
            <div className="flex flex-wrap justify-center gap-4">
              <Link to="/playground">
                <Button size="lg" variant="secondary">
                  Open Playground
                </Button>
              </Link>
              <a
                href="https://github.com/jklarenbeek/jarenjs"
                target="_blank"
                rel="noopener noreferrer"
              >
                <Button size="lg" variant="outline" className="border-primary-foreground/20 hover:bg-primary-foreground/10 gap-2">
                  <Github className="h-4 w-4" />
                  View on GitHub
                </Button>
              </a>
            </div>
          </div>
        </Container>
      </section>
    </div>
  );
}

export { Home };
