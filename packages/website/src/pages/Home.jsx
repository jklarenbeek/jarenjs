import { Link } from 'react-router-dom';
import { Container } from '@components/layout/Container';
import { Button } from '@components/ui/button';
import { FeatureGrid } from '@components/features/FeatureCard';
import { CodeBlock } from '@components/ui/code-block';
import { Badge } from '@components/ui/badge';
import { 
  Zap, 
  Shield, 
  Code2, 
  Puzzle, 
  Gauge, 
  GitBranch,
  ArrowRight,
  Play,
  BookOpen,
  BarChart3
} from 'lucide-react';

const features = [
  {
    icon: Zap,
    title: 'High Performance',
    description: 'Compiled validators that outperform AJV across the official JSON Schema test suites.',
  },
  {
    icon: Shield,
    title: 'Full Draft Support',
    description: '100% of the official JSON-Schema-Test-Suite for draft-07, 2019-09 and 2020-12 - every keyword, including unevaluated* and $dynamicRef.',
  },
  {
    icon: Code2,
    title: 'Modern JavaScript',
    description: 'Built with ES2024 features, native ESM support, and zero dependencies for core functionality.',
  },
  {
    icon: Puzzle,
    title: 'Modular Architecture',
    description: 'Core, validation, formats, refs and forms are separate packages. Use only what you need.',
  },
  {
    icon: Gauge,
    title: 'Benchmarking',
    description: 'Continuous performance monitoring against AJV with detailed reports and visualizations.',
  },
  {
    icon: GitBranch,
    title: '$ref Resolution',
    description: 'Advanced reference resolution with support for $recursiveRef, $dynamicRef, and internal anchors.',
  },
];

const installCode = `npm install jarenjs`;

const usageCode = `import { JarenValidator } from '@jarenjs/validate';
import { stringFormats } from '@jarenjs/formats';

// Create validator instance
const validator = new JarenValidator()
  .addFormats(stringFormats);

// Compile a schema
const validate = validator.compile({
  type: 'object',
  properties: {
    name: { type: 'string', minLength: 1 },
    email: { type: 'string', format: 'email' },
    age: { type: 'integer', minimum: 0 },
  },
  required: ['name', 'email'],
});

// Validate data
const isValid = validate({
  name: 'John Doe',
  email: 'john@example.com',
  age: 30,
}); // returns true`;

function Home() {
  return (
    <div>
      {/* Hero Section */}
      <section className="py-20 lg:py-32 bg-gradient-to-b from-background to-muted/30">
        <Container>
          <div className="text-center max-w-3xl mx-auto">
            <div className="flex justify-center mb-6">
              <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-primary text-primary-foreground font-bold text-4xl shadow-lg">
                J
              </div>
            </div>
            
            <h1 className="text-4xl md:text-6xl font-bold tracking-tight mb-6">
              JarenJS
            </h1>
            
            <p className="text-xl md:text-2xl text-muted-foreground mb-8">
              A modern, high-performance JSON Schema validator for JavaScript
            </p>
            
            <div className="flex flex-wrap justify-center gap-4 mb-12">
              <Badge variant="secondary" className="text-sm px-3 py-1">
                773+ Tests Passing
              </Badge>
              <Badge variant="secondary" className="text-sm px-3 py-1">
                Draft 07 / 2019-09 / 2020-12
              </Badge>
              <Badge variant="secondary" className="text-sm px-3 py-1">
                Zero Dependencies
              </Badge>
              <Badge variant="secondary" className="text-sm px-3 py-1">
                ESM Native
              </Badge>
            </div>
            
            <div className="flex flex-wrap justify-center gap-4">
              <Link to="/playground">
                <Button size="lg" className="gap-2">
                  <Play className="h-4 w-4" />
                  Try Playground
                </Button>
              </Link>
              <Link to="/docs">
                <Button size="lg" variant="outline" className="gap-2">
                  <BookOpen className="h-4 w-4" />
                  Documentation
                </Button>
              </Link>
              <Link to="/benchmarks">
                <Button size="lg" variant="outline" className="gap-2">
                  <BarChart3 className="h-4 w-4" />
                  Benchmarks
                </Button>
              </Link>
            </div>
          </div>
        </Container>
      </section>

      {/* Quick Install */}
      <section className="py-12 border-y bg-muted/30">
        <Container>
          <div className="max-w-2xl mx-auto">
            <h2 className="text-center text-sm font-medium text-muted-foreground mb-4 uppercase tracking-wider">
              Quick Start
            </h2>
            <CodeBlock showCopy>{installCode}</CodeBlock>
          </div>
        </Container>
      </section>

      {/* Features */}
      <section className="py-20">
        <Container>
          <div className="text-center mb-12">
            <h2 className="text-3xl font-bold mb-4">Features</h2>
            <p className="text-muted-foreground max-w-2xl mx-auto">
              Everything you need for robust JSON Schema validation in modern JavaScript applications
            </p>
          </div>
          <FeatureGrid features={features} />
        </Container>
      </section>

      {/* Code Example */}
      <section className="py-20 bg-muted/30">
        <Container>
          <div className="grid md:grid-cols-2 gap-12 items-center">
            <div>
              <h2 className="text-3xl font-bold mb-4">Simple & Intuitive API</h2>
              <p className="text-muted-foreground mb-6">
                Compile your schemas once and validate data efficiently. 
                Support for all standard JSON Schema keywords, formats, and references.
              </p>
              <ul className="space-y-3 mb-8">
                <li className="flex items-center gap-2">
                  <ArrowRight className="h-4 w-4 text-primary" />
                  <span>Compile-time schema validation</span>
                </li>
                <li className="flex items-center gap-2">
                  <ArrowRight className="h-4 w-4 text-primary" />
                  <span>Detailed error reporting</span>
                </li>
                <li className="flex items-center gap-2">
                  <ArrowRight className="h-4 w-4 text-primary" />
                  <span>Format validators included</span>
                </li>
                <li className="flex items-center gap-2">
                  <ArrowRight className="h-4 w-4 text-primary" />
                  <span>Full $ref resolution support</span>
                </li>
              </ul>
              <Link to="/examples">
                <Button variant="outline">View More Examples</Button>
              </Link>
            </div>
            <CodeBlock showCopy>{usageCode}</CodeBlock>
          </div>
        </Container>
      </section>

      {/* Stats */}
      <section className="py-20">
        <Container>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 text-center">
            <div>
              <p className="text-4xl font-bold text-primary">773+</p>
              <p className="text-sm text-muted-foreground mt-1">Test Cases</p>
            </div>
            <div>
              <p className="text-4xl font-bold text-primary">3</p>
              <p className="text-sm text-muted-foreground mt-1">Draft Versions</p>
            </div>
            <div>
              <p className="text-4xl font-bold text-primary">~2M</p>
              <p className="text-sm text-muted-foreground mt-1">Ops/Second</p>
            </div>
            <div>
              <p className="text-4xl font-bold text-primary">0</p>
              <p className="text-sm text-muted-foreground mt-1">Dependencies</p>
            </div>
          </div>
        </Container>
      </section>

      {/* CTA */}
      <section className="py-20 bg-primary text-primary-foreground">
        <Container>
          <div className="text-center max-w-2xl mx-auto">
            <h2 className="text-3xl font-bold mb-4">Ready to get started?</h2>
            <p className="text-primary-foreground/80 mb-8">
              Try the interactive playground, explore the documentation, or check out the benchmarks.
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
                <Button size="lg" variant="outline" className="border-primary-foreground/20 hover:bg-primary-foreground/10">
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
