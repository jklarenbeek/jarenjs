//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid, toMermaid, MermaidParseError, parseMermaidConfig } from '@jarenjs/mermaid';

describe('parseMermaid: flowchart', function () {
  it('parses directions, shapes, edges and labels', function () {
    const doc = parseMermaid(`flowchart LR
      A[Start] --> B{Choice}
      B -->|yes| C((Done))
      B -->|no| A`);
    assert.equal(doc.$mermaid, '0.1');
    assert.equal(doc.diagram, 'flowchart');
    assert.equal(doc.ast.direction, 'LR');
    assert.equal(doc.ast.nodes.length, 3);
    const byId = Object.fromEntries(doc.ast.nodes.map((n) => [n.id, n]));
    assert.equal(byId.A.shape, 'rect');
    assert.equal(byId.B.shape, 'diamond');
    assert.equal(byId.C.shape, 'circle');
    assert.equal(doc.ast.edges.length, 3);
    assert.equal(doc.ast.edges[0].label, null); // A --> B, unlabeled
    assert.equal(doc.ast.edges[1].label, 'yes'); // B -->|yes| C
    assert.equal(doc.ast.edges[1].head, 'arrow');
  });

  it('parses graph alias, subgraphs, classDef/class/style', function () {
    const doc = parseMermaid(`graph TD
      subgraph one [Group One]
        A --> B
      end
      C --> A
      classDef hot fill:#f00
      class B hot
      style C fill:#0f0`);
    assert.equal(doc.diagram, 'flowchart');
    assert.equal(doc.ast.subgraphs.length, 1);
    assert.equal(doc.ast.subgraphs[0].label, 'Group One');
    assert.deepEqual(doc.ast.subgraphs[0].nodes, ['A', 'B']);
    assert.equal(doc.ast.classDefs[0].name, 'hot');
    assert.deepEqual(doc.ast.classes[0], { node: 'B', name: 'hot' });
    assert.equal(doc.ast.styles[0].node, 'C');
  });

  it('parses thick and dotted links with lengths', function () {
    const doc = parseMermaid(`flowchart TD
      A ==> B
      B -.-> C
      C --- D`);
    assert.equal(doc.ast.edges[0].stroke, 'thick');
    assert.equal(doc.ast.edges[1].stroke, 'dotted');
    assert.equal(doc.ast.edges[2].stroke, 'solid');
    assert.equal(doc.ast.edges[2].head, 'none');
  });
});

describe('parseMermaid: sequence', function () {
  it('parses participants, messages, activation and notes', function () {
    const doc = parseMermaid(`sequenceDiagram
      participant A as Alice
      participant B as Bob
      A->>+B: Hello
      B-->>-A: Hi
      note over A,B: chat`);
    assert.equal(doc.diagram, 'sequence');
    assert.equal(doc.ast.participants.length, 2);
    assert.equal(doc.ast.participants[0].label, 'Alice');
    const msg = doc.ast.statements[0];
    assert.equal(msg.kind, 'message');
    assert.equal(msg.head, 'arrow');
    assert.equal(msg.activation, 'activate');
    const note = doc.ast.statements[2];
    assert.equal(note.kind, 'note');
    assert.deepEqual(note.actors, ['A', 'B']);
  });

  it('parses nested loop/alt blocks', function () {
    const doc = parseMermaid(`sequenceDiagram
      A->>B: go
      alt ok
        A->>B: yes
      else no
        A->>A: retry
      end`);
    const block = doc.ast.statements[1];
    assert.equal(block.kind, 'block');
    assert.equal(block.blockType, 'alt');
    assert.equal(block.branches.length, 2);
    assert.equal(block.branches[1].label, 'no');
  });
});

describe('parseMermaid: other types', function () {
  it('parses pie, state, class, er, gantt', function () {
    assert.equal(parseMermaid('pie\n"A" : 1\n"B" : 2').diagram, 'pie');
    assert.equal(parseMermaid('stateDiagram-v2\n[*] --> S\nS --> [*]').diagram, 'state');
    assert.equal(parseMermaid('classDiagram\nclass Foo').diagram, 'class');
    assert.equal(parseMermaid('erDiagram\nA ||--o{ B : has').diagram, 'er');
    // a Gantt task needs a dated anchor: this engine has no clock, so
    // the undated form Mermaid would start "today" is an error (see
    // test/mermaid/gantt.test.js)
    assert.equal(parseMermaid('gantt\ntitle X\nsection S\nT : a, 2024-01-01, 1d').diagram, 'gantt');
  });

  it('parses ER relationships whose cardinality token contains a brace', function () {
    // `o{`/`}o` embed a brace, so the relationship must be matched before
    // the '{' entity-block check — otherwise `CUSTOMER ||--o{ ORDER` is
    // misread as an entity block named `CUSTOMER ||--o`.
    const { ast } = parseMermaid('erDiagram\n'
      + '  CUSTOMER ||--o{ ORDER : places\n'
      + '  ORDER }o--|| PRODUCT : contains\n'
      + '  CUSTOMER {\n    string name PK\n  }');
    assert.deepEqual(ast.entities.map((e) => e.name), ['CUSTOMER', 'ORDER', 'PRODUCT']);
    assert.equal(ast.relationships.length, 2);
    const [r0, r1] = ast.relationships;
    assert.deepEqual(
      { left: r0.left, leftCard: r0.leftCard, rightCard: r0.rightCard, right: r0.right, label: r0.label },
      { left: 'CUSTOMER', leftCard: '||', rightCard: 'o{', right: 'ORDER', label: 'places' });
    assert.equal(r1.leftCard, '}o');
    // the CUSTOMER entity block still parses its attribute
    assert.deepEqual(ast.entities[0].attributes, [{ type: 'string', name: 'name', keys: ['PK'] }]);
  });

  it('parse-accepts secondary types as raw', function () {
    const doc = parseMermaid('mindmap\n  root\n    child');
    assert.equal(doc.diagram, 'mindmap');
    assert.ok(Array.isArray(doc.ast.lines));
  });
});

describe('parse errors', function () {
  it('reports an unknown diagram type with a line', function () {
    assert.throws(() => parseMermaid('nonsense TD\nA-->B'), (err) => {
      assert.ok(err instanceof MermaidParseError);
      assert.equal(err.line, 1);
      return true;
    });
  });

  it('reports an unterminated shape with a line', function () {
    assert.throws(() => parseMermaid('flowchart TD\n  A[oops'), (err) => {
      assert.ok(err instanceof MermaidParseError);
      assert.equal(err.line, 2);
      return true;
    });
  });
});

describe('parseMermaidConfig', function () {
  it('extracts frontmatter title + config and strips comments/init', function () {
    const { config, title, body } = parseMermaidConfig(`---
title: My Chart
config:
  theme: forest
---
%%{init: {"flowchart": {"curve": "basis"}}}%%
%% a comment
flowchart TD
  A --> B`);
    assert.equal(title, 'My Chart');
    assert.equal(config.theme, 'forest');
    assert.deepEqual(config.flowchart, { curve: 'basis' });
    assert.equal(body.includes('%%'), false);
    assert.equal(body.trim().startsWith('flowchart'), true);
  });
});


describe('state transition labels — the UML reading', function () {
  const t = (label) => {
    const src = label === null
      ? 'stateDiagram-v2\nA --> B'
      : `stateDiagram-v2\nA --> B : ${label}`;
    return parseMermaid(src).ast.transitions[0];
  };

  it('parses all eight presence combinations of event/guard/effect', function () {
    assert.deepEqual(t(null), {
      from: 'A', to: 'B', label: null, event: null, guard: null, effect: null, parent: null,
    });
    assert.deepEqual(t('go'), {
      from: 'A', to: 'B', label: 'go', event: 'go', guard: null, effect: null, parent: null,
    });
    assert.deepEqual(t('[x > 1]'), {
      from: 'A', to: 'B', label: '[x > 1]', event: null, guard: 'x > 1', effect: null, parent: null,
    });
    assert.deepEqual(t('/ act'), {
      from: 'A', to: 'B', label: '/ act', event: null, guard: null, effect: 'act', parent: null,
    });
    assert.deepEqual(t('go [x]'), {
      from: 'A', to: 'B', label: 'go [x]', event: 'go', guard: 'x', effect: null, parent: null,
    });
    assert.deepEqual(t('go / act'), {
      from: 'A', to: 'B', label: 'go / act', event: 'go', guard: null, effect: 'act', parent: null,
    });
    assert.deepEqual(t('[x] / act'), {
      from: 'A', to: 'B', label: '[x] / act', event: null, guard: 'x', effect: 'act', parent: null,
    });
    assert.deepEqual(t('go [x] / act'), {
      from: 'A', to: 'B', label: 'go [x] / act', event: 'go', guard: 'x', effect: 'act', parent: null,
    });
  });

  it('reads no-pattern labels whole as the event (the historical meaning)', function () {
    const cases = [
      'array[0] fetch',       // text between ] and the end
      'go [x] weird / act',   // text between ] and /
      'broken [x',            // unmatched [
    ];
    for (const label of cases) {
      assert.deepEqual(t(label), {
        from: 'A', to: 'B', label, event: label, guard: null, effect: null, parent: null,
      }, label);
    }
    assert.equal(t('go [a[0] > 1] / act').guard, 'a[0] > 1', 'nested brackets stay inside the guard');
    assert.equal(t('go / a / b').effect, 'a / b', 'the effect starts at the FIRST slash');
  });

  it('prints the verbatim label back (toMermaid fixed point) and renders it', function () {
    const src = 'stateDiagram-v2\nA --> B : go [x > 1] / act';
    const doc = parseMermaid(src);
    assert.match(toMermaid(doc), /A --> B : go \[x > 1\] \/ act/);
    assert.deepEqual(parseMermaid(toMermaid(doc)).ast, doc.ast, 'label round-trips byte for byte');
  });
});
