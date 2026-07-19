//@ts-check
/**
 * @file A curated Mermaid corpus for benchmark/mermaid.js.
 *
 * Used both as the coverage-scorecard corpus (does jaren-mermaid parse
 * AND render each without error?) and as the perf corpus. This is the
 * documented fallback to a full `mermaid-js/mermaid` submodule
 * (TODO_18 WI 8 / precondition 6): the standalone `@mermaid-js/parser`
 * only covers a handful of newer grammars (pie, gitGraph, packet, …) and
 * cannot parse flowchart/sequence at all, so a full-repo submodule buys
 * no head-to-head there. The head-to-head runs on the overlapping type
 * (pie); everything else is jaren-only.
 */

/** One representative diagram per first-class + secondary type. */
export const CORPUS = {
  flowchart: [
    'flowchart TD\n  A[Start] --> B{Is it?}\n  B -->|Yes| C[OK]\n  B -->|No| D[End]\n  C --> D',
    'flowchart LR\n  A(round) --> B([stadium])\n  B --> C{{hex}}\n  C ==> D[(db)]\n  D -.-> E((circle))',
  ],
  sequence: [
    'sequenceDiagram\n  participant A as Alice\n  participant B as Bob\n  A->>+B: Authenticate\n  B-->>-A: Token\n  note over A,B: handshake',
    'sequenceDiagram\n  A->>B: go\n  alt ok\n    A->>B: yes\n  else no\n    A->>A: retry\n  end',
  ],
  state: [
    'stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running : start\n  Running --> Idle : stop\n  Running --> [*]',
  ],
  class: [
    'classDiagram\n  class Animal {\n    +String name\n    +move()\n  }\n  Animal <|-- Dog',
  ],
  er: [
    'erDiagram\n  CUSTOMER ||--o{ ORDER : places\n  ORDER {\n    int id\n    string sku\n  }',
  ],
  gantt: [
    'gantt\n  title Roadmap\n  dateFormat YYYY-MM-DD\n  section Phase 1\n  Design : a1, 2024-01-01, 5d\n  Build : a2, after a1, 10d',
  ],
  pie: [
    'pie showData\n  title Pets\n  "Dogs" : 40\n  "Cats" : 25\n  "Birds" : 10',
    'pie\n  "Alpha" : 3\n  "Beta" : 7\n  "Gamma" : 2',
  ],
  mindmap: [
    'mindmap\n  root((core))\n    parse\n    layout\n    render',
  ],
  gitGraph: [
    'gitGraph\n  commit\n  branch dev\n  commit\n  checkout main\n  merge dev',
  ],
};

/**
 * Perf documents at three sizes for a given type: a scaled flowchart
 * and a scaled sequence exercise the hot parse/layout/render paths.
 * @param {number} n number of nodes/messages
 * @returns {{ flowchart: string, sequence: string }}
 */
export function buildScaled(n) {
  let flow = 'flowchart TD\n';
  for (let i = 0; i < n; i++) {
    flow += `  N${i}[Node ${i}] --> N${i + 1}[Node ${i + 1}]\n`;
  }
  let seq = 'sequenceDiagram\n  participant A\n  participant B\n';
  for (let i = 0; i < n; i++) {
    seq += `  A->>B: message ${i}\n  B-->>A: reply ${i}\n`;
  }
  return { flowchart: flow, sequence: seq };
}

/** The pie head-to-head corpus (both engines parse pie). */
export const PIE_CORPUS = CORPUS.pie;
