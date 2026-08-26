//@ts-check
/**
 * @file A curated Mermaid corpus for benchmark/mermaid.js.
 *
 * Used both as the coverage-scorecard corpus (does jaren-mermaid parse
 * AND render each without error?) and as the perf corpus. This is the
 * documented fallback to a full `mermaid-js/mermaid` submodule: the
 * standalone `@mermaid-js/parser` only covers a handful of newer grammars
 * (pie, gitGraph, packet, …) and cannot parse flowchart/sequence at all,
 * so a full-repo submodule buys no head-to-head there. The head-to-head
 * runs on the overlapping type (pie); everything else is jaren-only.
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

/**
 * A scaled Gantt schedule: sections of a hundred tasks, each section
 * anchored by a date and each task inside it following the one before.
 *
 * The shape is deliberate. A single chain of ten thousand `after`
 * dependencies is not a schedule anyone writes and it would measure the
 * resolver's recursion depth rather than its work, so the dependency
 * depth stays at a hundred while the task count scales. `excludes
 * weekends` is on, because the working calendar is the part of the
 * resolver worth measuring.
 *
 * @param {number} n number of tasks
 * @returns {string} a gantt document
 */
export function buildGantt(n) {
  const PER_SECTION = 100;
  let out = 'gantt\ntitle Scaled plan\ndateFormat YYYY-MM-DD\nexcludes weekends\n';
  for (let i = 0; i < n; i++) {
    if (i % PER_SECTION === 0) {
      out += `section Phase ${i / PER_SECTION}\n`;
      // a fresh anchor per section: 2024-01-01 plus one week per section
      const day = 1 + (i / PER_SECTION) * 7;
      out += `Task ${i} : t${i}, ${isoDay(day)}, ${(i % 9) + 1}d\n`;
      continue;
    }
    out += `Task ${i} : t${i}, after t${i - 1}, ${(i % 9) + 1}d\n`;
  }
  return out;
}

/**
 * The `day`-th day of 2024, as `YYYY-MM-DD`. Written out rather than
 * formatted so the fixture stays dependency-free.
 * @param {number} day 1-based day of the year
 * @returns {string}
 */
function isoDay(day) {
  const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  let rest = ((day - 1) % 366) + 1;
  let month = 0;
  while (rest > MONTH_DAYS[month]) {
    rest -= MONTH_DAYS[month];
    month++;
  }
  const mm = month + 1 < 10 ? `0${month + 1}` : `${month + 1}`;
  const dd = rest < 10 ? `0${rest}` : `${rest}`;
  return `2024-${mm}-${dd}`;
}

/** The pie head-to-head corpus (both engines parse pie). */
export const PIE_CORPUS = CORPUS.pie;
