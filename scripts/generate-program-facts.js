//@ts-check
import { readFileSync, existsSync } from 'node:fs';
const read = (name) => JSON.parse(readFileSync(new URL(`../benchmark/programmind-${name}.json`, import.meta.url), 'utf8'));
const table = (head, rows) => '\n\n' + [head, head.replace(/[^|]/g, '-'), ...rows].join('\n') + '\n\n';
/** Authored-program measurements share the repository's fact namespace and runner. */
export const programFacts = {
  name: 'program measurements',
  docs: () => ['packages/ai/README.md', 'benchmark/README.md'],
  facts: () => ({
    'program.reuse': () => {
      const { baseline, runtime, selected } = read('reuse');
      return `${runtime.questions}/${runtime.questions} fixture answers correct; ${runtime.authorCalls} author calls and ${runtime.tokens} token proxy with reuse, versus ${baseline.authorCalls} calls and ${baseline.tokens} tokens fresh. Selected threshold ${selected.threshold} with ${selected.dims} hash dimensions, host suitability proof and an outcome checker.`;
    },
    'program.depth': () => table('| depth | correct fixture tasks | author calls | subcalls | token proxy |',
      read('depth-fixture').rows.filter((row) => row.seed === 17).map((row) =>
        `| ${row.depth} | ${row.correct ? 1 : 0}/1 | ${row.authorCalls} | ${row.subcalls} | ${row.tokens} |`)),
    'program.profiles': () => table('| grammar | full closure bytes | profile bytes | full branches | profile branches |',
      read('profiles').rows.map((row) => `| ${row.grammar} | ${row.full.bytes} | ${row.profile.bytes} | ${row.full.branches} | ${row.profile.branches} |`)),
    'program.live': () => {
      const runs = ['authoring-live', 'authoring-remeasured-live'].filter((name) => existsSync(new URL(`../benchmark/programmind-${name}.json`, import.meta.url)));
      return table('| instrument | profile / model | attempts | correct | timeout | other failures |', runs.flatMap((name) => {
        const rows = read(name).rows;
        return [...new Set(rows.map((row) => row.profile))].map((profile) => {
          const group = rows.filter((row) => row.profile === profile);
          const correct = group.filter((row) => row.outcome === 'correct').length;
          const timeout = group.filter((row) => row.outcome === 'timeout').length;
          return `| ${name} | ${profile} / ${group[0].model} | ${group.length} | ${correct} | ${timeout} | ${group.length - correct - timeout} |`;
        });
      }));
    },
    'program.depthLive': () => {
      const rows = read('depth-live').rows;
      return `${rows.filter((row) => row.correct).length}/${rows.length} live depth tasks correct; ${rows.reduce((sum, row) => sum + row.timeouts, 0)} timed-out calls and ${rows.flatMap((row) => row.routes).filter((row) => row.outcome === 'token-limit').length} provider token-ceiling violations. No deeper default is justified.`;
    },
    'program.reuseLive': () => table('| profile | mode | correct | author calls | reported tokens | reused answers |',
      ['primary', 'secondary'].flatMap((profile) => ['fresh', 'reuse'].map((mode) => {
        const rows = read('reuse-live').rows.filter((row) => row.profile === profile && row.mode === mode);
        return `| ${profile} | ${mode} | ${rows.filter((row) => row.correct).length}/${rows.length} | ${rows.reduce((sum, row) => sum + row.authorCalls, 0)} | ${rows.reduce((sum, row) => sum + row.tokens, 0)} | ${rows.filter((row) => row.reused).length} |`;
      }))),
  }),
};
