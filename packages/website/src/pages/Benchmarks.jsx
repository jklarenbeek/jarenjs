import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Container } from '@components/layout/Container';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@components/ui/tabs';
import { useBenchmarkFile } from '@hooks/useBenchmarkData';
import { MetaStrip } from '@components/benchmarks/shared';
import { OverviewTab } from '@components/benchmarks/OverviewTab';
import { ValidateBenchmark } from '@components/benchmarks/ValidateBenchmark';
import { PathBenchmark } from '@components/benchmarks/PathBenchmark';
import { QueryBenchmark } from '@components/benchmarks/QueryBenchmark';
import { JsltBenchmark } from '@components/benchmarks/JsltBenchmark';
import { PointerBenchmark } from '@components/benchmarks/PointerBenchmark';
import { PatchBenchmark } from '@components/benchmarks/PatchBenchmark';
import { TomlBenchmark } from '@components/benchmarks/TomlBenchmark';

const SUITES = [
  { key: 'overview', label: 'Overview' },
  { key: 'validate', label: 'JSON Schema' },
  { key: 'jsonpath', label: 'JSONPath' },
  { key: 'jsonquery', label: 'JSON Query' },
  { key: 'jslt', label: 'JSLT' },
  { key: 'jsonpointer', label: 'JSON Pointer' },
  { key: 'jsonpatch', label: 'JSON Patch' },
  { key: 'toml', label: 'JOSL / TOML' },
];

function Benchmarks() {
  const [searchParams, setSearchParams] = useSearchParams();
  const suiteParam = searchParams.get('suite');
  const active = SUITES.some((s) => s.key === suiteParam) ? suiteParam : 'overview';
  const { data: meta } = useBenchmarkFile('meta');

  const setActive = useCallback((key) => {
    setSearchParams(key === 'overview' ? {} : { suite: key }, { replace: true });
  }, [setSearchParams]);

  return (
    <div className="py-8">
      <Container>
        <div className="mb-6">
          <h1 className="text-3xl font-bold mb-2">Benchmarks</h1>
          <p className="text-muted-foreground max-w-3xl">
            Six engines, each measured against the strongest competitor on its own turf — down to the individual
            test case. Correctness first: every suite asserts conformance or result equivalence before timing anything.
          </p>
          <div className="mt-3">
            <MetaStrip meta={meta} command="npm run benchmark:generate" />
          </div>
        </div>

        <Tabs value={active} onValueChange={setActive}>
          <TabsList className="mb-6 flex-wrap h-auto">
            {SUITES.map((suite) => (
              <TabsTrigger key={suite.key} value={suite.key}>{suite.label}</TabsTrigger>
            ))}
          </TabsList>

          <TabsContent value="overview">
            <OverviewTab onSelect={setActive} />
          </TabsContent>
          <TabsContent value="validate">
            <ValidateBenchmark />
          </TabsContent>
          <TabsContent value="jsonpath">
            <PathBenchmark />
          </TabsContent>
          <TabsContent value="jsonquery">
            <QueryBenchmark />
          </TabsContent>
          <TabsContent value="jslt">
            <JsltBenchmark />
          </TabsContent>
          <TabsContent value="jsonpointer">
            <PointerBenchmark />
          </TabsContent>
          <TabsContent value="jsonpatch">
            <PatchBenchmark />
          </TabsContent>
          <TabsContent value="toml">
            <TomlBenchmark />
          </TabsContent>
        </Tabs>
      </Container>
    </div>
  );
}

export { Benchmarks };
