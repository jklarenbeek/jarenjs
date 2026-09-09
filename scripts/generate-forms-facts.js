//@ts-check
import { readFileSync } from 'node:fs';

/** Forms addressing evidence uses the shared documentation fact gate. */
export const formsFacts = {
  name: 'forms addressing measurements',
  docs: () => ['packages/forms/README.md'],
  facts: () => ({
    'forms.addressing': () => {
      const result = JSON.parse(readFileSync(new URL('../benchmark/forms-composition-result.json', import.meta.url), 'utf8'));
      return `\n\nMeasured on ${result.node}, ${result.platform}/${result.arch}; median milliseconds per expanded-field projection. Compilation and field expansion are excluded from all contenders.\n\n`
        + '| Depth | Nodes | Root pointers | Carried cursors | Fold stylesheet |\n'
        + '|---|---|---|---|---|\n'
        + result.rows.map((row) => `| ${row.depth} | ${row.nodes} | ${row.rootPointers.toFixed(4)} | ${row.carriedCursors.toFixed(4)} | ${row.foldStylesheet.toFixed(4)} |`).join('\n') + '\n\n';
    },
  }),
};
