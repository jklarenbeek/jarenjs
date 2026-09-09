import { compileStatechart, createStatechartSession, compileWorkflow, lowerWorkflow } from '@jarenjs/flow';
import type { StatechartState, StatechartResult, WorkflowSnapshot, WorkflowStore, WorkflowResult } from '@jarenjs/flow';

const chart = compileStatechart({ $fsm: '0.2', initial: 'ready', states: ['ready'], transitions: [] });
const start: StatechartResult = chart.start({ now: 0 });
const saved: StatechartState = chart.restore(start.state);
const session = createStatechartSession(chart, { state: saved });
const step: StatechartResult = session.send('go');
const tick: StatechartResult = session.advance(10);
void [step, tick, saved.history, saved.timers[0]?.at];
// @ts-expect-error returned snapshots are immutable
saved.active.push('changed');
// @ts-expect-error statecharts require structured control, not a flat FSM id
chart.step('ready', 'go');
// @ts-expect-error time is supplied as a number
chart.advance(saved, 'tomorrow');

const snapshots = new Map<string, WorkflowSnapshot>();
const store: WorkflowStore = {
  load: async (id) => snapshots.get(id) ?? null,
  save: async (id, snapshot, generation) => {
    if ((snapshots.get(id)?.generation ?? 0) !== generation) return false;
    snapshots.set(id, snapshot); return true;
  },
};
const doc = { $workflow: '0.2', revision: '1', initial: 'done', states: { done: { final: true } } };
const workflow = compileWorkflow(doc, { store, tasks: { task: { version: '1', run: ({input}) => input } } });
const lowered = lowerWorkflow(doc);
const source: string = lowered.sources['/states/done'];
const revision: string = workflow.revisions.dags['/states/work'];
const version: string = workflow.taskVersions['/states/work/task'];
void [source, revision, version];
async function run() {
  const result: WorkflowResult = await workflow.run(null, { runId: 'typed', expectedGeneration: 0 });
  const status: 'waiting' | 'done' = result.status;
  const generation: number = result.snapshot.generation;
  void [status, generation];
}
void run;
// @ts-expect-error every workflow run has an explicit identity
workflow.run(null, {});
// @ts-expect-error store save must return the outcome of atomic comparison
const invalidStore: WorkflowStore = { load: () => null, save() {} };
void invalidStore;
