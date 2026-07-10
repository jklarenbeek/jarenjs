import { Container } from '@components/layout/Container';
import { DraftSupport, keywordCategories } from '@components/features/DraftSupport';
import { CodeBlock } from '@components/ui/code-block';
import { Badge } from '@components/ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '@components/ui/card';

const basicExample = `import { JarenValidator } from '@jarenjs/validate';
import { stringFormats } from '@jarenjs/formats';

const validator = new JarenValidator()
  .addFormats(stringFormats);

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    email: { type: 'string', format: 'email' },
  },
  required: ['name'],
};

const validate = validator.compile(schema);
const isValid = validate({ name: 'John', email: 'john@example.com' });`;

const errorCollectionExample = `import { ValidationOptions } from '@jarenjs/validate';

const validator = new JarenValidator({
  collectErrors: true,  // Collect all errors
  skipErrors: false,    // Don't stop at first error
});

const validate = validator.compile(schema);
const result = validate(invalidData);

// result is now an object: { valid: false, errors: [...] }
console.log(result.errors);`;

const refExample = `const validator = new JarenValidator();

// Add referenced schemas
validator.addSchema({
  $id: 'https://example.com/address',
  type: 'object',
  properties: {
    street: { type: 'string' },
    city: { type: 'string' },
  },
});

// Use $ref in main schema
const schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    address: { $ref: 'https://example.com/address' },
  },
};

const validate = validator.compile(schema);`;

function Documentation() {
  return (
    <div className="py-8">
      <Container>
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Documentation</h1>
          <p className="text-muted-foreground">
            Learn how to use JarenJS for JSON Schema validation in your JavaScript applications.
          </p>
        </div>

        <div className="grid lg:grid-cols-4 gap-8">
          {/* Sidebar Navigation */}
          <div className="hidden lg:block space-y-6">
            <div>
              <h3 className="font-semibold mb-3">Getting Started</h3>
              <ul className="space-y-2 text-sm">
                <li><a href="#installation" className="text-muted-foreground hover:text-primary">Installation</a></li>
                <li><a href="#quick-start" className="text-muted-foreground hover:text-primary">Quick Start</a></li>
                <li><a href="#basic-usage" className="text-muted-foreground hover:text-primary">Basic Usage</a></li>
              </ul>
            </div>
            <div>
              <h3 className="font-semibold mb-3">Configuration</h3>
              <ul className="space-y-2 text-sm">
                <li><a href="#validation-options" className="text-muted-foreground hover:text-primary">Validation Options</a></li>
                <li><a href="#error-handling" className="text-muted-foreground hover:text-primary">Error Handling</a></li>
                <li><a href="#formats" className="text-muted-foreground hover:text-primary">Formats</a></li>
              </ul>
            </div>
            <div>
              <h3 className="font-semibold mb-3">Advanced</h3>
              <ul className="space-y-2 text-sm">
                <li><a href="#refs" className="text-muted-foreground hover:text-primary">$ref Resolution</a></li>
                <li><a href="#draft-support" className="text-muted-foreground hover:text-primary">Draft Support</a></li>
                <li><a href="#keywords" className="text-muted-foreground hover:text-primary">Keywords</a></li>
              </ul>
            </div>
          </div>

          {/* Main Content */}
          <div className="lg:col-span-3 space-y-12">
            {/* Installation */}
            <section id="installation">
              <h2 className="text-2xl font-bold mb-4">Installation</h2>
              <p className="text-muted-foreground mb-4">
                Install JarenJS via npm. The core package provides the validator, 
                while additional packages offer formats and reference resolution.
              </p>
              <CodeBlock showCopy>npm install @jarenjs/validate @jarenjs/formats</CodeBlock>
            </section>

            {/* Quick Start */}
            <section id="quick-start">
              <h2 className="text-2xl font-bold mb-4">Quick Start</h2>
              <p className="text-muted-foreground mb-4">
                Here&apos;s a simple example to get you started with JarenJS:
              </p>
              <CodeBlock showCopy>{basicExample}</CodeBlock>
            </section>

            {/* Validation Options */}
            <section id="validation-options">
              <h2 className="text-2xl font-bold mb-4">Validation Options</h2>
              <p className="text-muted-foreground mb-4">
                Configure validation behavior using ValidationOptions:
              </p>
              
              <Card className="mb-4">
                <CardContent className="pt-6">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b">
                        <th className="text-left py-2">Option</th>
                        <th className="text-left py-2">Type</th>
                        <th className="text-left py-2">Default</th>
                        <th className="text-left py-2">Description</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-b">
                        <td className="py-2 font-mono text-xs">skipErrors</td>
                        <td className="py-2">boolean</td>
                        <td className="py-2">true</td>
                        <td className="py-2 text-muted-foreground">Stop at first error</td>
                      </tr>
                      <tr className="border-b">
                        <td className="py-2 font-mono text-xs">useGrapheme</td>
                        <td className="py-2">boolean</td>
                        <td className="py-2">true</td>
                        <td className="py-2 text-muted-foreground">Use grapheme cluster counting</td>
                      </tr>
                      <tr>
                        <td className="py-2 font-mono text-xs">collectErrors</td>
                        <td className="py-2">boolean</td>
                        <td className="py-2">false</td>
                        <td className="py-2 text-muted-foreground">Return detailed errors</td>
                      </tr>
                    </tbody>
                  </table>
                </CardContent>
              </Card>
            </section>

            {/* Error Handling */}
            <section id="error-handling">
              <h2 className="text-2xl font-bold mb-4">Error Handling</h2>
              <p className="text-muted-foreground mb-4">
                When collectErrors is enabled, validation returns an object with detailed error information:
              </p>
              <CodeBlock showCopy>{errorCollectionExample}</CodeBlock>
              
              <div className="mt-4">
                <h3 className="font-semibold mb-2">Error Object Structure</h3>
                <ul className="text-sm text-muted-foreground space-y-1">
                  <li><code className="bg-muted px-1 rounded">keyword</code> - The validation keyword that failed</li>
                  <li><code className="bg-muted px-1 rounded">instancePath</code> - JSON Pointer to the data location</li>
                  <li><code className="bg-muted px-1 rounded">schemaPath</code> - JSON Pointer to the schema location</li>
                  <li><code className="bg-muted px-1 rounded">params</code> - Keyword-specific parameters</li>
                  <li><code className="bg-muted px-1 rounded">message</code> - Human-readable error message</li>
                </ul>
              </div>
            </section>

            {/* Formats */}
            <section id="formats">
              <h2 className="text-2xl font-bold mb-4">Format Validators</h2>
              <p className="text-muted-foreground mb-4">
                JarenJS supports standard JSON Schema formats. Import format validators from @jarenjs/formats:
              </p>
              
              <div className="grid sm:grid-cols-2 gap-4">
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">String Formats</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-1">
                      {['email', 'date-time', 'date', 'time', 'hostname', 'ipv4', 'ipv6', 'uri', 'uuid', 'regex'].map(f => (
                        <Badge key={f} variant="secondary" className="text-xs">{f}</Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">DateTime Formats</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap gap-1">
                      {['date', 'time', 'date-time', 'duration'].map(f => (
                        <Badge key={f} variant="secondary" className="text-xs">{f}</Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>
            </section>

            {/* $ref Resolution */}
            <section id="refs">
              <h2 className="text-2xl font-bold mb-4">$ref Resolution</h2>
              <p className="text-muted-foreground mb-4">
                JarenJS supports standard JSON Schema reference resolution:
              </p>
              <ul className="text-sm text-muted-foreground space-y-1 mb-4">
                <li>• Standard <code className="bg-muted px-1 rounded">$ref</code> with JSON Pointer and URI</li>
                <li>• <code className="bg-muted px-1 rounded">$anchor</code> for named schema locations</li>
                <li>• <code className="bg-muted px-1 rounded">$id</code> for schema identification</li>
              </ul>
              
              <div className="rounded-lg border border-dashed p-4 bg-amber-50 dark:bg-amber-950/30 mb-4">
                <p className="text-sm text-amber-800 dark:text-amber-200">
                  <strong>Note:</strong> Dynamic reference keywords ($recursiveRef, $recursiveAnchor, $dynamicRef, $dynamicAnchor) are currently in development.
                </p>
              </div>
              
              <CodeBlock showCopy>{refExample}</CodeBlock>
            </section>

            {/* Draft Support */}
            <section id="draft-support">
              <h2 className="text-2xl font-bold mb-4">JSON Schema Draft Support</h2>
              <DraftSupport />
            </section>

            {/* Keywords */}
            <section id="keywords">
              <h2 className="text-2xl font-bold mb-4">Supported Keywords</h2>
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6">
                {keywordCategories.map((category) => (
                  <Card key={category.name}>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">{category.name}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="flex flex-wrap gap-1">
                        {category.keywords.map((keyword) => (
                          <Badge key={keyword} variant="secondary" className="text-xs">
                            {keyword}
                          </Badge>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
              
              <div className="rounded-lg border border-dashed p-4 bg-muted/30">
                <h4 className="font-medium mb-2">Keywords Not Yet Supported</h4>
                <p className="text-sm text-muted-foreground mb-3">
                  The following keywords from Draft 2019-09 and 2020-12 are currently in development:
                </p>
                <div className="flex flex-wrap gap-2">
                  {['unevaluatedItems', 'unevaluatedProperties', 'propertyDependencies'].map((kw) => (
                    <Badge key={kw} variant="outline" className="text-xs text-muted-foreground">
                      {kw}
                    </Badge>
                  ))}
                </div>
              </div>
            </section>
          </div>
        </div>
      </Container>
    </div>
  );
}

export { Documentation };
