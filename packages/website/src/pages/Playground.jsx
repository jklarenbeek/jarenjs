import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Container } from '@components/layout/Container';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@components/ui/tabs';
import { LiveValidator } from '@components/demo/LiveValidator';
import { PathPlayground } from '@components/demo/PathPlayground';
import { PointerPlayground } from '@components/demo/PointerPlayground';
import { PatchPlayground } from '@components/demo/PatchPlayground';
import { QueryPlayground } from '@components/demo/QueryPlayground';
import { JsltPlayground } from '@components/demo/JsltPlayground';
import { JtltPlayground } from '@components/demo/JtltPlayground';
import { XQueryPlayground } from '@components/demo/XQueryPlayground';
import { JoslPlayground } from '@components/demo/JoslPlayground';

const ENGINES = [
  {
    key: 'schema',
    label: 'JSON Schema',
    blurb: 'Compile a schema, validate live, and watch @jarenjs/forms render it as a working form — all three in one loop.',
  },
  {
    key: 'jsonpath',
    label: 'JSONPath',
    blurb: 'RFC 9535 selectors compiled to closures — values and normalized paths, live.',
  },
  {
    key: 'pointer',
    label: 'JSON Pointer',
    blurb: 'RFC 6901 absolute and relative pointers — the compiled getters behind the $data keyword.',
  },
  {
    key: 'patch',
    label: 'JSON Patch',
    blurb: 'RFC 6902 and RFC 7396 partial updates plus standalone write operations, all copy-on-write — and a structural diff that writes the patches for you.',
  },
  {
    key: 'query',
    label: 'JSON Query',
    blurb: 'XQuery 3.1 semantics as JSON documents: FLWOR, joins, grouping, quantifiers, schema-typed operators.',
  },
  {
    key: 'jslt',
    label: 'JSLT',
    blurb: 'Recursive stylesheets: match by path or by schema, transform with query documents, share what did not change.',
  },
  {
    key: 'jtlt',
    label: 'JTLT',
    blurb: 'The same dispatcher aimed at text: rule bodies are segments — render JSON to Markdown, XML or code, escaped where it counts.',
  },
  {
    key: 'xquery',
    label: 'XQuery',
    blurb: 'Type XQuery text, watch it become a query document, run it — the same front-end that faces the W3C QT3 suite.',
  },
  {
    key: 'josl',
    label: 'JOSL',
    blurb: 'Research: TOML 1.0 plus JavaScript’s obvious types — null, bigint, regexp, real dates, streamable [[]] records — parsed in document order.',
  },
];

function Playground() {
  const [searchParams, setSearchParams] = useSearchParams();
  const engineParam = searchParams.get('engine');
  const active = ENGINES.some((e) => e.key === engineParam) ? engineParam : 'schema';

  const setActive = useCallback((key) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (key === 'schema') next.delete('engine'); else next.set('engine', key);
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  const activeEngine = ENGINES.find((e) => e.key === active);

  return (
    <div className="py-8">
      <Container>
        <div className="mb-6">
          <h1 className="text-3xl font-bold mb-2">Playground</h1>
          <p className="text-muted-foreground max-w-3xl">
            Every engine in the toolchain, running live in your browser — no server, no eval, the exact same
            compilers you would ship. {activeEngine?.blurb}
          </p>
        </div>

        <Tabs value={active} onValueChange={setActive}>
          <TabsList className="mb-6 flex-wrap h-auto">
            {ENGINES.map((engine) => (
              <TabsTrigger key={engine.key} value={engine.key}>{engine.label}</TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="schema">
            <LiveValidator />
          </TabsContent>
          <TabsContent value="jsonpath">
            <PathPlayground />
          </TabsContent>
          <TabsContent value="pointer">
            <PointerPlayground />
          </TabsContent>
          <TabsContent value="patch">
            <PatchPlayground />
          </TabsContent>
          <TabsContent value="query">
            <QueryPlayground />
          </TabsContent>
          <TabsContent value="jslt">
            <JsltPlayground />
          </TabsContent>
          <TabsContent value="jtlt">
            <JtltPlayground />
          </TabsContent>
          <TabsContent value="xquery">
            <XQueryPlayground />
          </TabsContent>
          <TabsContent value="josl">
            <JoslPlayground />
          </TabsContent>
        </Tabs>
      </Container>
    </div>
  );
}

export { Playground };
