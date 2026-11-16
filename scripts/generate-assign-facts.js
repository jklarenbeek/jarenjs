//@ts-check
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/**
 * The assignment engine's published figures, derived from the committed
 * measurement `benchmark/assign-result.json`. The measurement names the
 * files it read its inputs from and their hash; a derivation over a
 * measurement whose inputs have changed since refuses, so the documents
 * never carry figures of a corpus or a benchmark that no longer exists.
 */

/** @returns {any} */
function measured() {
  const result = JSON.parse(readFileSync(new URL('../benchmark/assign-result.json', import.meta.url), 'utf8'));
  if (result.format !== 'jaren-assign-measurements/1' || result.quick) throw new Error('benchmark/assign-result.json is not a full measurement');
  const hash = createHash('sha256');
  for (const file of result.inputs) hash.update(file).update('\0').update(readFileSync(new URL(`../${file}`, import.meta.url))).update('\0');
  if (hash.digest('hex') !== result.inputsHash) throw new Error('benchmark/assign-result.json was measured over other inputs: run node benchmark/assign.js');
  return result;
}

const ms = (/** @type {number} */ ns) => (ns >= 1e8 ? (ns / 1e6).toFixed(0) : ns >= 1e7 ? (ns / 1e6).toFixed(1) : (ns / 1e6).toFixed(2));
const kib = (/** @type {number} */ bytes) => (bytes / 1024).toFixed(0);
const mib = (/** @type {number} */ bytes) => (bytes / 1048576).toFixed(2);
const thousands = (/** @type {number} */ n) => n.toLocaleString('en-US');
const level = (/** @type {any} */ s) => (s === null ? '—' : `${s.hard} / ${s.service} / ${s.soft}`);
const host = (/** @type {any} */ r) => `Measured on ${r.runtime.node}, ${r.runtime.platform}/${r.runtime.arch}, ${r.runtime.cpu}`
  + ` (load average ${r.runtime.loadBefore[0]} before, ${r.loadAfter[0]} after).`;

/** @param {any} row */
function sizeText(row) {
  if (row.size.instances !== undefined) return `${row.size.instances} instances`;
  const own = row.size.assignments > 0 ? `, ${thousands(row.size.assignments)} held` : '';
  return `${thousands(row.size.resources)} × ${thousands(row.size.tasks)} (${thousands(row.size.places)} places${own})`;
}

/** @param {any} row */
function budgetText(row) {
  const parts = Object.entries(row.options.budgets ?? {}).map(([name, value]) => `${name} ${thousands(/** @type {number} */ (value))}`);
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

export const assignFacts = {
  name: 'assignment measurements',
  docs: () => ['packages/core/docs/ASSIGN.md'],
  facts: () => ({
    'assign.corpus': () => {
      const { corpus } = measured();
      const statuses = Object.entries(corpus.statuses).map(([status, n]) => `${status} ${n}`).join(', ');
      const reached = Object.entries(corpus.optimaReached).map(([label, r]) => `${label} ${/** @type {any} */ (r).reached} of ${/** @type {any} */ (r).of}`).join('; ');
      return `\n\n${corpus.instances} instances, ${corpus.calls.length} calls each where they apply: ${corpus.answers} answers, `
        + `**${corpus.agreed} of ${corpus.answers}** agreed with by the independent validator (${statuses}). `
        + `On the ${corpus.proofs} instances the oracle enumerates within \`SOLVE_LIMITS\`, \`exhaustive\` answered the proof's status, best score and bound `
        + `${corpus.proofsMatched} times of ${corpus.proofs}. The heuristics reached a proven optimum (counted where the proof is \`optimal\`, `
        + `\`local\` only where the problem holds no assignment of its own, \`limit\` answers left out): ${reached}.\n\n`;
    },
    'assign.measurements': () => {
      const result = measured();
      const rows = result.classes.map((/** @type {any} */ row) => {
        const runs = row.latency.runs.map((/** @type {any} */ run) => ms(run.medianNs)).join(' / ');
        const counts = row.counts === null ? '—' : `${thousands(row.counts.nodes)} / ${thousands(row.counts.moves)}`;
        const more = row.counts === null || row.counts.restarts === null ? '—' : `${row.counts.restarts} / ${thousands(row.counts.editWork)}`;
        return `| ${row.domain} | \`${row.strategy}\`${budgetText(row)} | ${sizeText(row)} | ${row.status} | ${level(row.score)} | ${level(row.bound)}`
          + ` | ${row.churn ?? '—'} | ${counts} | ${more} | ${runs} | ${row.latency.spread.toFixed(2)} | ${kib(row.retainedBytes)} | ${row.validated} |`;
      });
      const edits = result.incremental.map((/** @type {any} */ m) => `| ${m.mode}: ${m.note} | ${thousands(m.assignments)} | ${m.units === null ? '—' : thousands(m.units)}`
        + ` | ${m.fullNs.map(ms).join(' / ')} | ${m.applyNs.map(ms).join(' / ')} | ${m.whatIfNs.map(ms).join(' / ')}`
        + ` | ${m.speedup.map((/** @type {number} */ x) => `${x.toFixed(1)}×`).join(' / ')} | ${m.fullFallbacks} of ${m.edits + m.previews} | ${mib(m.liveBytes)} |`);
      return `\n\n${host(result)} Method: ${result.method}. Rival: ${result.rival}.\n\n`
        + '| Class | Strategy | Resources × tasks | Status | Score (hard / service / soft) | Bound | Churn | Nodes / moves | Restarts / rule evaluations | Median ms (process 1 / 2 / 3) | Spread | Retained heap KiB | Validated by |\n'
        + '|---|---|---|---|---|---|---:|---|---|---|---:|---:|---|\n'
        + `${rows.join('\n')}\n\n`
        + '`fullFallbacks` is the evaluator\'s count; `solve` does not report it, so it is per edit only:\n\n'
        + '| Mode | Assignments | Units | Full scoring ms (1 / 2 / 3) | `apply` ms (1 / 2 / 3) | `whatIf` ms (1 / 2 / 3) | Full ÷ `apply` | `fullFallbacks` | Evaluator live MiB |\n'
        + '|---|---:|---:|---|---|---|---|---:|---:|\n'
        + `${edits.join('\n')}\n\n`;
    },
  }),
};
