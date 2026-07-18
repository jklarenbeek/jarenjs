import { useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import PropTypes from 'prop-types';
import { Container } from '@components/layout/Container';
import { CodeBlock } from '@components/ui/code-block';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@components/ui/tabs';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@components/ui/card';
import { Button } from '@components/ui/button';
import { Play } from 'lucide-react';
import {
  pathExamples,
  pointerExamples,
  patchExamples,
  queryExamples,
  jsltExamples,
  jtltExamples,
  xqueryExamples,
  joslExamples,
} from '@lib/playgroundExamples';
import { exampleSchemas } from '@lib/examples';

const pretty = (value) => JSON.stringify(value, null, 2);

const SECTIONS = [
  { key: 'schema', label: 'JSON Schema' },
  { key: 'jsonpath', label: 'JSONPath' },
  { key: 'pointer', label: 'JSON Pointer' },
  { key: 'patch', label: 'JSON Patch' },
  { key: 'query', label: 'JSON Query' },
  { key: 'jslt', label: 'JSLT' },
  { key: 'jtlt', label: 'JTLT' },
  { key: 'xquery', label: 'XQuery' },
  { key: 'josl', label: 'JOSL' },
];

function SectionIntro({ blurb, playground }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
      <p className="text-muted-foreground max-w-2xl">{blurb}</p>
      <Link to={playground}>
        <Button variant="outline" size="sm" className="gap-2">
          <Play className="h-3.5 w-3.5" />
          Run these live
        </Button>
      </Link>
    </div>
  );
}

SectionIntro.propTypes = {
  blurb: PropTypes.string.isRequired,
  playground: PropTypes.string.isRequired,
};

function Examples() {
  const [searchParams, setSearchParams] = useSearchParams();
  const sectionParam = searchParams.get('section');
  const active = SECTIONS.some((s) => s.key === sectionParam) ? sectionParam : 'schema';

  const setActive = useCallback((key) => {
    setSearchParams(key === 'schema' ? {} : { section: key }, { replace: true });
  }, [setSearchParams]);

  return (
    <div className="py-8">
      <Container>
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Examples</h1>
          <p className="text-muted-foreground max-w-3xl">
            Copy-paste patterns for every engine in the suite. Each block is executable exactly as shown — the
            same examples are one click away in the playground.
          </p>
        </div>

        <Tabs value={active} onValueChange={setActive}>
          <TabsList className="mb-6 flex-wrap h-auto">
            {SECTIONS.map((section) => (
              <TabsTrigger key={section.key} value={section.key}>{section.label}</TabsTrigger>
            ))}
          </TabsList>

          {/* JSON Schema */}
          <TabsContent value="schema">
            <SectionIntro
              blurb="From basic types to unevaluatedProperties, $dynamicRef and the $query cross-field keyword — all compiled, all draft-accurate."
              playground="/playground"
            />
            <div className="grid gap-6">
              {Object.entries(exampleSchemas).map(([key, example]) => (
                <Card key={key}>
                  <CardHeader>
                    <CardTitle>{example.name}</CardTitle>
                    {example.schema.description && <CardDescription>{example.schema.description}</CardDescription>}
                  </CardHeader>
                  <Tabs defaultValue="schema" className="px-6 pb-6">
                    <TabsList>
                      <TabsTrigger value="schema">Schema</TabsTrigger>
                      <TabsTrigger value="data">Valid data</TabsTrigger>
                    </TabsList>
                    <TabsContent value="schema" className="mt-4">
                      <CodeBlock showCopy>{pretty(example.schema)}</CodeBlock>
                    </TabsContent>
                    <TabsContent value="data" className="mt-4">
                      <CodeBlock showCopy>{pretty(example.data)}</CodeBlock>
                    </TabsContent>
                  </Tabs>
                </Card>
              ))}
            </div>
          </TabsContent>

          {/* JSONPath */}
          <TabsContent value="jsonpath">
            <SectionIntro
              blurb="RFC 9535 selectors against the classic bookstore document — filters, slices, descendants and I-Regexp functions."
              playground="/playground?engine=jsonpath"
            />
            <Card>
              <CardContent className="pt-5">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="text-left py-2 font-medium">What</th>
                      <th className="text-left py-2 font-medium">Selector</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pathExamples.map((example) => (
                      <tr key={example.name} className="border-b last:border-0">
                        <td className="py-2.5 pr-4">{example.name}</td>
                        <td className="py-2.5"><code className="bg-muted px-1.5 py-0.5 rounded text-xs">{example.selector}</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* JSON Pointer */}
          <TabsContent value="pointer">
            <SectionIntro
              blurb="Absolute and relative pointers — including the relative forms the validator's $data keyword resolves per instance."
              playground="/playground?engine=pointer"
            />
            <Card>
              <CardContent className="pt-5">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-xs text-muted-foreground">
                      <th className="text-left py-2 font-medium">What</th>
                      <th className="text-left py-2 font-medium">Pointer</th>
                      <th className="text-left py-2 font-medium">From location</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pointerExamples.map((example) => (
                      <tr key={example.name} className="border-b last:border-0">
                        <td className="py-2.5 pr-4">{example.name}</td>
                        <td className="py-2.5 pr-4"><code className="bg-muted px-1.5 py-0.5 rounded text-xs">{example.pointer === '' ? '"" (root)' : example.pointer}</code></td>
                        <td className="py-2.5 text-muted-foreground">
                          {example.mode === 'relative'
                            ? <code className="text-xs">{example.location}</code>
                            : <span className="text-xs">document root</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          </TabsContent>

          {/* JSON Patch */}
          <TabsContent value="patch">
            <SectionIntro
              blurb="Partial updates every way: precise RFC 6902 operations (with test preconditions, moves and copies), document-shaped RFC 7396 merges, standalone set/insert/remove writes at pointers or every JSONPath match, and structural diffs that write either patch format from two documents."
              playground="/playground?engine=patch"
            />
            <div className="grid md:grid-cols-2 gap-6">
              {patchExamples.map((example) => (
                <Card key={example.name}>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">{example.name}</CardTitle>
                    <CardDescription>
                      {example.mode === 'patch' && 'JSON Patch (RFC 6902) — applied copy-on-write, atomically'}
                      {example.mode === 'merge' && 'JSON Merge Patch (RFC 7396) — the patch looks like the document'}
                      {example.mode === 'write' && 'Write operation — one compiled set/insert/remove on the copy-on-write core'}
                      {example.mode === 'diff' && 'Structural diff — createJSONPatch / createMergePatch emit the patch'}
                    </CardDescription>
                  </CardHeader>
                  <Tabs defaultValue="patch" className="px-6 pb-6">
                    <TabsList>
                      <TabsTrigger value="patch">
                        {example.mode === 'diff' ? 'Target' : example.mode === 'merge' ? 'Merge patch'
                          : example.mode === 'write' ? 'Write' : 'Patch'}
                      </TabsTrigger>
                      <TabsTrigger value="document">{example.mode === 'diff' ? 'Source' : 'Document'}</TabsTrigger>
                    </TabsList>
                    <TabsContent value="patch" className="mt-4">
                      <CodeBlock showCopy>
                        {example.mode === 'write'
                          ? pretty({ op: example.writeOp, target: example.target, ...(example.value !== undefined && { value: example.value }) })
                          : pretty(example.mode === 'diff' ? example.target : example.patch)}
                      </CodeBlock>
                    </TabsContent>
                    <TabsContent value="document" className="mt-4">
                      <CodeBlock showCopy>{pretty(example.document)}</CodeBlock>
                    </TabsContent>
                  </Tabs>
                </Card>
              ))}
            </div>
          </TabsContent>

          {/* JSON Query */}
          <TabsContent value="query">
            <SectionIntro
              blurb="XQuery 3.1 semantics as JSON documents — filter, join, group, quantify, and type-check items with embedded JSON Schemas."
              playground="/playground?engine=query"
            />
            <div className="grid md:grid-cols-2 gap-6">
              {queryExamples.map((example) => (
                <Card key={example.name}>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">{example.name}</CardTitle>
                    {example.externals && (
                      <CardDescription>externals: <code>{JSON.stringify(example.externals)}</code></CardDescription>
                    )}
                  </CardHeader>
                  <CardContent>
                    <CodeBlock showCopy>{pretty(example.query)}</CodeBlock>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          {/* JSLT */}
          <TabsContent value="jslt">
            <SectionIntro
              blurb="Recursive template dispatch: match by path or by schema, transform with query documents, share whatever didn't change."
              playground="/playground?engine=jslt"
            />
            <div className="grid md:grid-cols-2 gap-6">
              {jsltExamples.map((example) => (
                <Card key={example.name}>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">{example.name}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <CodeBlock showCopy>{pretty(example.stylesheet)}</CodeBlock>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          {/* JTLT */}
          <TabsContent value="jtlt">
            <SectionIntro
              blurb="Rule-driven text rendering: the JSLT dispatcher pointed at Markdown, XML and code — literal text raw, interpolated data escaped."
              playground="/playground?engine=jtlt"
            />
            <div className="grid md:grid-cols-2 gap-6">
              {jtltExamples.map((example) => (
                <Card key={example.name}>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">{example.name}</CardTitle>
                  </CardHeader>
                  <Tabs defaultValue="template" className="px-6 pb-6">
                    <TabsList>
                      <TabsTrigger value="template">Template</TabsTrigger>
                      <TabsTrigger value="input">Input</TabsTrigger>
                    </TabsList>
                    <TabsContent value="template" className="mt-4">
                      <CodeBlock showCopy>{pretty(example.template)}</CodeBlock>
                    </TabsContent>
                    <TabsContent value="input" className="mt-4">
                      <CodeBlock showCopy>{pretty(example.document)}</CodeBlock>
                    </TabsContent>
                  </Tabs>
                </Card>
              ))}
            </div>
          </TabsContent>

          {/* XQuery */}
          <TabsContent value="xquery">
            <SectionIntro
              blurb="Real XQuery 3.1 text, parsed into query documents — the front-end that faces the 31,821-case W3C QT3 suite."
              playground="/playground?engine=xquery"
            />
            <div className="grid md:grid-cols-2 gap-6">
              {xqueryExamples.map((example) => (
                <Card key={example.name}>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">{example.name}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <CodeBlock showCopy>{example.text}</CodeBlock>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>

          {/* JOSL */}
          <TabsContent value="josl">
            <SectionIntro
              blurb="Research: a strict TOML 1.0 superset with JavaScript's obvious types — null, bigint, regexp, real dates — and a streamable [[]] root array for LLM record streams. Strict mode passes the complete official toml-test 1.0.0 suite."
              playground="/playground?engine=josl"
            />
            <div className="grid md:grid-cols-2 gap-6">
              {joslExamples.map((example) => (
                <Card key={example.name}>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">
                      {example.name}
                      <span className="ml-2 text-xs font-normal text-muted-foreground font-mono">mode: {example.mode}</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <CodeBlock showCopy>{example.text}</CodeBlock>
                  </CardContent>
                </Card>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </Container>
    </div>
  );
}

export { Examples };
