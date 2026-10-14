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
  'gantt\ntitle Plan\ndateFormat YYYY-MM-DD\nexcludes weekends\ntickInterval 1week\nweekday monday\n'
    + 'section Build\nDesign : done, a1, 2024-01-04, 3d\nShip : milestone, m1, after a1, 0d',
  'gantt\ndateFormat YYYY-MM-DD\nsection Build\nDesign : a1, 2024-01-04, 3d\nclick a1 href "https://x.test/p" call report(a1, "two words")\nclick a1,nope call go()',
  'gantt\ndateFormat YYYY-MM-DD\ninclusiveEndDates\nexcludes weekends\nincludes 2024-01-06\n'
    + 'section Build\nDesign : a1, 2024-01-04, 2024-01-08',
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

  it('accepts the gantt AST against its own $defs entry', function () {
    const ganttSchema = {
      $schema: schema.$schema,
      $ref: '#/$defs/ganttAst',
      $defs: schema.$defs,
    };
    const validateGantt = new JarenValidator().compile(ganttSchema);
    const doc = parseMermaid(CORPUS[CORPUS.length - 1]);
    assert.equal(validateGantt(doc.ast), true, 'the gantt $defs entry rejected a real gantt AST');
    const { rules, ...withoutRules } = doc.ast;
    assert.equal(rules.dateFormat, 'YYYY-MM-DD');
    assert.equal(validateGantt(withoutRules), false, 'rules is required');
    assert.equal(validateGantt({
      ...doc.ast,
      rules: { ...rules, tick: { amount: 0, unit: 'fortnight' } },
    }), false, 'a tick interval is a positive count of a documented unit');
  });

  it('describes a click statement, and accepts a tree written before they were read', function () {
    const validateGantt = new JarenValidator().compile({
      $schema: schema.$schema,
      $ref: '#/$defs/ganttAst',
      $defs: schema.$defs,
    });
    const { ast } = parseMermaid(CORPUS[CORPUS.length - 2]);
    assert.deepEqual(ast.clicks.map((/** @type {any} */ c) => c.ids), [['a1'], ['a1', 'nope']]);
    assert.equal(validateGantt(ast), true);
    const { clicks, ...older } = ast;
    assert.equal(clicks.length, 2);
    assert.equal(validateGantt(older), true, 'clicks is not required');
    assert.equal(validateGantt({ ...ast, clicks: [{ ...clicks[0], ids: [] }] }), false, 'a click names a task');
    assert.equal(validateGantt({ ...ast, clicks: [{ ...clicks[0], href: null, call: null }] }), false,
      'a click carries a link, a call or both');
    assert.equal(validateGantt({ ...ast, clicks: [{ ...clicks[0], call: { name: 'f' } }] }), false,
      'a call carries its argument list');
  });

  it('rejects a document missing the envelope keys', function () {
    assert.equal(validate({ diagram: 'flowchart' }), false);
  });
});
