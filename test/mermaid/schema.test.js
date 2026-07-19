//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JarenValidator } from '@jarenjs/validate';
import { parseMermaid } from '@jarenjs/mermaid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, '..', '..', 'components', 'mermaid', 'schemas', 'jaren-mermaid-ast.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

const CORPUS = [
  'flowchart TD\n  A[Start] --> B{Q}\n  B -->|yes| C((Done))',
  'sequenceDiagram\n  A->>+B: hi\n  B-->>-A: bye',
  'pie\n  "a" : 1\n  "b" : 2',
  'stateDiagram-v2\n  [*] --> S\n  S --> [*]',
  'classDiagram\n  class Foo { +int x }',
  'erDiagram\n  A ||--o{ B : has',
  'mindmap\n  root\n    child',
];

describe('the DiagramDocument AST JSON Schema', function () {
  const validate = new JarenValidator().compile(schema);

  it('accepts every document the parser produces', function () {
    for (const src of CORPUS) {
      const doc = parseMermaid(src);
      assert.equal(validate(doc), true,
        `schema rejected parser output for ${JSON.stringify(src)}`);
    }
  });

  it('rejects a document missing the envelope keys', function () {
    assert.equal(validate({ diagram: 'flowchart' }), false);
  });
});
