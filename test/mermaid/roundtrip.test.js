//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { parseMermaid, toMermaid } from '@jarenjs/mermaid';

/** The fixed-point corpus (design decision D12). */
const FIXTURES = [
  `flowchart TD
    A[Start] --> B{Is it?}
    B -->|Yes| C[OK]
    B -->|No| D[End]
    C --> D`,
  `flowchart LR
    A(round) --> B([stadium])
    B --> C{{hexagon}}
    C ==> D[(db)]
    D -.-> E((circle))`,
  `flowchart TD
    A --> B
    B --o C
    C --x D
    A <--> D`,
  `sequenceDiagram
    participant A as Alice
    participant B as Bob
    A->>+B: Authenticate
    B-->>-A: Token
    note over A,B: handshake
    alt success
      A->>B: proceed
    else failure
      A->>A: retry
    end`,
  `sequenceDiagram
    autonumber
    A->>B: one
    loop retry
      B-->>A: two
    end`,
];

describe('toMermaid round-trip fixed point', function () {
  for (let i = 0; i < FIXTURES.length; i++) {
    it(`fixture ${i} re-parses deep-equal`, function () {
      const doc = parseMermaid(FIXTURES[i]);
      const printed = toMermaid(doc);
      const doc2 = parseMermaid(printed);
      assert.deepEqual(doc2.ast, doc.ast);
    });
  }

  it('a transformed AST re-emits correct Mermaid text', function () {
    const doc = parseMermaid('flowchart TD\n  A[Start] --> B[Middle]\n  B --> C[End]');
    // JSLT-style edit: relabel a node, add an edge.
    const edited = structuredClone(doc);
    edited.ast.nodes[1].label = 'Renamed';
    const text = toMermaid(edited);
    assert.match(text, /B\[Renamed\]/);
    // And it re-parses to the edited AST.
    assert.deepEqual(parseMermaid(text).ast, edited.ast);
  });
});
