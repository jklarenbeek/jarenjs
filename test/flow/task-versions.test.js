//@ts-check
/**
 * @file Declared task versions (FLOW-FORMAT §7.8): a checkpointed node
 * says which handler implementation its recorded value belongs to, the
 * registry has to say the same thing, and a compiled workflow hands back
 * one canonical map of those identities — sorted, so two compiles of the
 * same document answer the same map whatever order it was written in.
 *
 * Identity is DECLARED. Nothing here hashes a function: a reformat is
 * not a new task, and a changed dependency is not the same one.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { compileDag } from '@jarenjs/flow';

/** A two-task graph; the first is checkpointed. */
const docWith = (nodes) => ({
  $dag: '0.1',
  nodes: {
    in: { kind: 'input' },
    ...nodes,
    out: { kind: 'output' },
  },
  edges: [
    { from: 'in', to: 'first' },
    { from: 'first', to: 'second' },
    { from: 'second', to: 'out' },
  ],
});

const TWO_TASKS = docWith({
  first: { kind: 'task', run: 'alpha', checkpoint: true, version: '1' },
  second: { kind: 'task', run: 'beta', version: '2' },
});

const registry = (extra = {}) => ({
  alpha: { version: '1', run: ({ input }) => ({ n: 1, input }) },
  beta: { version: '2', run: ({ input }) => ({ n: 2, input }) },
  ...extra,
});

const store = () => {
  const values = {};
  return {
    values,
    load: () => ({ values }),
    save: (runId, nodeId, value) => { values[nodeId] = value; },
    complete: () => {},
  };
};

describe('a checkpointed task declares its handler version', () => {
  it('compiles when the node and the registry agree', () => {
    const dag = compileDag(TWO_TASKS, { tasks: registry(), checkpoint: store() });
    assert.deepStrictEqual(dag.taskVersions, { first: '1', second: '2' });
  });

  it('refuses a checkpointed node that declares none, before any node runs', () => {
    let ran = 0;
    const doc = docWith({
      first: { kind: 'task', run: 'alpha', checkpoint: true },
      second: { kind: 'task', run: 'beta', version: '2' },
    });
    assert.throws(() => compileDag(doc, {
      tasks: registry({ alpha: { version: '1', run: () => { ran++; return 1; } } }),
      checkpoint: store(),
    }), (error) => /** @type {any} */ (error).code === 'JF0011'
      && /must also declare a "version"/.test(/** @type {Error} */ (error).message)
      && /** @type {any} */ (error).docPath === '/nodes/first/version');
    assert.strictEqual(ran, 0, 'nothing ran: this is a compile-time refusal');
  });

  it('refuses a version the registry does not match, naming both', () => {
    let ran = 0;
    assert.throws(() => compileDag(TWO_TASKS, {
      tasks: registry({ alpha: { version: '9', run: () => { ran++; return 1; } } }),
      checkpoint: store(),
    }), (error) => /** @type {any} */ (error).code === 'JF0019'
      && /declares version '1'/.test(/** @type {Error} */ (error).message)
      && /at version '9'/.test(/** @type {Error} */ (error).message));
    assert.strictEqual(ran, 0);
  });

  it('refuses a declared version against a BARE handler, and says how to fix it', () => {
    assert.throws(() => compileDag(TWO_TASKS, {
      tasks: registry({ alpha: () => 1 }),
      checkpoint: store(),
    }), (error) => /** @type {any} */ (error).code === 'JF0019'
      && /bare handler with no version/.test(/** @type {Error} */ (error).message)
      && /\{ run, version \}/.test(/** @type {Error} */ (error).message));
  });

  it('refuses a blank or non-string version on either side', () => {
    assert.throws(() => compileDag(docWith({
      first: { kind: 'task', run: 'alpha', checkpoint: true, version: '' },
      second: { kind: 'task', run: 'beta', version: '2' },
    }), { tasks: registry(), checkpoint: store() }),
    (error) => /** @type {any} */ (error).code === 'JF0011'
      && /not a non-empty string/.test(/** @type {Error} */ (error).message));

    assert.throws(() => compileDag(TWO_TASKS, {
      tasks: registry({ alpha: { version: 7, run: () => 1 } }),
      checkpoint: store(),
    }), TypeError);

    assert.throws(() => compileDag(TWO_TASKS, {
      tasks: registry({ alpha: { run: 'not a function' } }),
      checkpoint: store(),
    }), TypeError);
  });
});

describe('the canonical version map', () => {
  it('retains task identities that match inherited object member names', () => {
    const names = ['__proto__', 'constructor', 'toString'];
    const dag = compileDag({
      $dag: '0.1',
      nodes: {
        i: { kind: 'input' },
        ...Object.fromEntries(names.map((name) => [name, { kind: 'task', run: 'task', version: '1' }])),
        o: { kind: 'output' },
      },
      edges: [
        { from: 'i', to: names[0] },
        { from: names[0], to: names[1] },
        { from: names[1], to: names[2] },
        { from: names[2], to: 'o' },
      ],
    }, { tasks: { task: { version: '1', run: () => null } } });
    assert.deepStrictEqual(dag.taskVersions, Object.fromEntries(names.map((name) => [name, '1'])));
    assert.strictEqual(Object.getPrototypeOf(dag.taskVersions), Object.prototype);
    assert.strictEqual(Object.isFrozen(dag.taskVersions), true);
  });

  it('is sorted, and stable under the declaration order', () => {
    const forward = compileDag({
      $dag: '0.1',
      nodes: {
        in: { kind: 'input' },
        zulu: { kind: 'task', run: 'z', version: '3' },
        alpha: { kind: 'task', run: 'a', version: '1' },
        mike: { kind: 'task', run: 'm', version: '2' },
        out: { kind: 'output' },
      },
      edges: [
        { from: 'in', to: 'zulu' }, { from: 'zulu', to: 'alpha' },
        { from: 'alpha', to: 'mike' }, { from: 'mike', to: 'out' },
      ],
    }, { tasks: { z: { version: '3', run: () => 1 }, a: { version: '1', run: () => 1 }, m: { version: '2', run: () => 1 } } });

    const reversed = compileDag({
      $dag: '0.1',
      nodes: {
        in: { kind: 'input' },
        mike: { kind: 'task', run: 'm', version: '2' },
        alpha: { kind: 'task', run: 'a', version: '1' },
        zulu: { kind: 'task', run: 'z', version: '3' },
        out: { kind: 'output' },
      },
      edges: [
        { from: 'in', to: 'zulu' }, { from: 'zulu', to: 'alpha' },
        { from: 'alpha', to: 'mike' }, { from: 'mike', to: 'out' },
      ],
    }, { tasks: { m: { version: '2', run: () => 1 }, a: { version: '1', run: () => 1 }, z: { version: '3', run: () => 1 } } });

    assert.deepStrictEqual(Object.keys(forward.taskVersions), ['alpha', 'mike', 'zulu']);
    assert.deepStrictEqual(forward.taskVersions, reversed.taskVersions);
    assert.strictEqual(JSON.stringify(forward.taskVersions),
      JSON.stringify(reversed.taskVersions), 'byte-equal, not merely deep-equal');
  });

  it('composes a nested workflow\'s versions under the node path', () => {
    const inner = compileDag({
      $dag: '0.1',
      nodes: {
        in: { kind: 'input' },
        step: { kind: 'task', run: 'deep', version: 'd1' },
        out: { kind: 'output' },
      },
      edges: [{ from: 'in', to: 'step' }, { from: 'step', to: 'out' }],
    }, { tasks: { deep: { version: 'd1', run: () => 'deep' } } });
    assert.deepStrictEqual(inner.taskVersions, { step: 'd1' });

    // the outer graph registers the inner workflow AS a handler; its map
    // rides under the node that runs it, so the composed run has one
    // identity rather than two
    const outer = compileDag(TWO_TASKS, {
      tasks: registry({
        alpha: { version: '1', run: (props) => inner.run(props.input), taskVersions: inner.taskVersions },
      }),
      checkpoint: store(),
    });
    assert.deepStrictEqual(outer.taskVersions,
      { first: '1', 'first/step': 'd1', second: '2' });
    assert.deepStrictEqual(Object.keys(outer.taskVersions),
      ['first', 'first/step', 'second'], 'sorted, nested path included');
  });

  it('omits a task that declares no version — the legacy shorthand', () => {
    const dag = compileDag(docWith({
      first: { kind: 'task', run: 'alpha' },
      second: { kind: 'task', run: 'beta' },
    }), { tasks: { alpha: () => 1, beta: () => 2 } });
    assert.deepStrictEqual(dag.taskVersions, {});
  });

  it('is frozen', () => {
    const dag = compileDag(TWO_TASKS, { tasks: registry(), checkpoint: store() });
    assert.strictEqual(Object.isFrozen(dag.taskVersions), true);
  });
});

describe('the legacy shorthand, explicitly', () => {
  it('a bare handler still runs a workflow that checkpoints NOTHING', async () => {
    const dag = compileDag(docWith({
      first: { kind: 'task', run: 'alpha' },
      second: { kind: 'task', run: 'beta' },
    }), { tasks: { alpha: ({ input }) => ({ n: 1, input }), beta: ({ input }) => ({ n: 2, input }) } });
    assert.deepStrictEqual(await dag.run({ seed: true }),
      { n: 2, input: { n: 1, input: { seed: true } } });
    assert.deepStrictEqual(dag.taskVersions, {});
  });

  it('but a checkpointed node cannot use it — the shorthand carries no identity', () => {
    assert.throws(() => compileDag(docWith({
      first: { kind: 'task', run: 'alpha', checkpoint: true },
      second: { kind: 'task', run: 'beta' },
    }), { tasks: { alpha: () => 1, beta: () => 2 }, checkpoint: store() }),
    (error) => /** @type {any} */ (error).code === 'JF0011');
  });

  it('a versioned node may run without a checkpoint store at all', async () => {
    const dag = compileDag(docWith({
      first: { kind: 'task', run: 'alpha', version: '1' },
      second: { kind: 'task', run: 'beta', version: '2' },
    }), { tasks: registry() });
    assert.deepStrictEqual(await dag.run({ seed: 1 }),
      { n: 2, input: { n: 1, input: { seed: 1 } } });
    assert.deepStrictEqual(dag.taskVersions, { first: '1', second: '2' });
  });
});
