//@ts-check
/**
 * @file THE correctness argument: applying the emitted patches to the
 * before-state reproduces the after-state EXACTLY, over a seeded
 * corpus of random write sequences — inserts, updates, deletes,
 * nested JSONB edits, array surgery, unicode and hostile keys,
 * booleans, composite keys, membership changes, multi-op
 * transactions, aborted transactions, caught inner rollbacks and
 * no-op writes — in BOTH capture modes. The mirror is maintained
 * SOLELY by `applyJSONPatch` over the observed patches; at every
 * checkpoint it must deep-equal what the database actually contains.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { applyJSONPatch } from '@jarenjs/json/patch';
import { openStore } from '@jarenjs/db';
import { nodeDriver } from '@jarenjs/db/node';
import { mulberry32 } from '@jarenjs/core/random';

import { deepEquals } from './oracle/harness.js';

const MODEL = {
  $model: '0.1',
  collections: {
    docs: {
      schema: { type: 'object', properties: {
        id: { type: 'string' }, body: { type: 'string' },
        nested: { type: 'object' }, list: { type: 'array' } } },
      key: '/id',
      indexes: [{ name: 'by_body', path: '$.body' }],
    },
  },
  entities: {
    Item: {
      schema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', 'x-entity': { key: true } },
          n: { type: 'integer' },
          on: { type: 'boolean' },
          extra: { type: 'object' },
          tags: { 'x-entity': { relation: { to: 'Tag', many: true } } },
        },
      },
    },
    Tag: {
      schema: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string', 'x-entity': { key: true } } },
      },
    },
    Grade: {
      schema: {
        type: 'object',
        required: ['s', 'c'],
        properties: {
          s: { type: 'string', 'x-entity': { key: true } },
          c: { type: 'string', 'x-entity': { key: true } },
          v: { type: 'integer' },
        },
      },
    },
  },
};

// hostile-by-construction identifier pool: pointer metacharacters,
// unicode, whitespace
const KEY_POOL = ['plain', 'a~b', 'x/y', '~1', '/', 'ünïcode-ключ', 'sp ace', '"q"'];
const WORDS = ['één', 'twee', '☂', 'x'.repeat(40), '~/', ''];

/** Read the WHOLE database state through the store, mirror-shaped. */
async function stateOf(store) {
  /** @type {any} */
  const state = { docs: {}, Item: {}, Tag: {}, Grade: {}, Item_Tag: {} };
  const all = await Promise.resolve(store.collection('docs').execute({
    $for: { it: '$[*]' }, $return: '$it' }));
  for (const doc of Array.isArray(all) ? all : all === undefined ? [] : [all])
    state.docs[doc.id] = doc;
  for (const item of await store.entity('Item').asNoTracking().load({}))
    state.Item[item.id] = structuredClone(item);
  for (const tag of await store.entity('Tag').asNoTracking().load({}))
    state.Tag[tag.name] = structuredClone(tag);
  for (const grade of await store.entity('Grade').asNoTracking().load({}))
    state.Grade[JSON.stringify([grade.s, grade.c])] = structuredClone(grade);
  // membership through a loaded include, normalized to join rows
  for (const item of await store.entity('Item').asNoTracking()
    .load({ include: { tags: true } })) {
    for (const tag of item.tags ?? []) {
      state.Item_Tag[JSON.stringify([item.id, tag.name])] = {
        Item_key: item.id, Tag_key: tag.name };
    }
  }
  for (const item of Object.values(state.Item)) delete item.tags;
  return state;
}

function randomDoc(rand, id) {
  const doc = { id, body: WORDS[Math.floor(rand() * WORDS.length)] };
  if (rand() < 0.7) {
    doc.nested = { deep: { v: Math.floor(rand() * 100) } };
    if (rand() < 0.5) doc.nested['~odd/key'] = WORDS[Math.floor(rand() * WORDS.length)];
  }
  if (rand() < 0.6) {
    doc.list = Array.from({ length: Math.floor(rand() * 4) },
      () => Math.floor(rand() * 10));
  }
  return doc;
}

async function runCorpus(mode, seed, steps) {
  const store = await openStore(MODEL,
    { driver: nodeDriver(), capture: { mode } });
  const rand = mulberry32(seed);
  let mirror = { docs: {}, Item: {}, Tag: {}, Grade: {}, Item_Tag: {} };
  store.observe((record) => {
    mirror = applyJSONPatch(mirror, record.patch);
  });
  for (const name of ['t1', 't2', 't3']) await store.entity('Tag').create({ name });

  for (let step = 0; step < steps; step++) {
    const roll = rand();
    const key = KEY_POOL[Math.floor(rand() * KEY_POOL.length)];
    try {
      if (roll < 0.2) {
        const doc = randomDoc(rand, key);
        if (mirror.docs[key] === undefined) {
          await store.collection('docs').insert(doc);
        }
        else {
          await store.collection('docs').put(doc, key);
        }
      }
      else if (roll < 0.3) {
        if (mirror.docs[key] !== undefined) {
          await store.collection('docs').patch(key, [
            { op: rand() < 0.5 ? 'add' : 'replace', path: '/body', value: 'patched' },
            ...(mirror.docs[key].nested !== undefined
              ? [{ op: 'replace', path: '/nested/deep', value: { v: -1 } }] : []),
          ]);
        }
      }
      else if (roll < 0.38) {
        await store.collection('docs').delete(key);
      }
      else if (roll < 0.55) {
        const id = key;
        if (mirror.Item[id] === undefined) {
          await store.entity('Item').create({
            id, n: Math.floor(rand() * 50), on: rand() < 0.5,
            ...(rand() < 0.5 ? { extra: { note: WORDS[Math.floor(rand() * WORDS.length)] } } : {}),
          });
        }
        else {
          await store.entity('Item').update(id, {
            n: Math.floor(rand() * 50),
            on: rand() < 0.5 ? undefined : true,
            extra: rand() < 0.4 ? undefined : { note: 'upd', arr: [1, [2, { z: null }]] },
          });
        }
      }
      else if (roll < 0.63) {
        // the unit of work with membership churn
        const id = key;
        if (mirror.Item[id] !== undefined) {
          const items = store.entity('Item');
          items.discard(id);
          const current = await items.get(id);
          const tags = ['t1', 't2', 't3'].filter(() => rand() < 0.5);
          items.put({ ...current, n: (current.n ?? 0) + 1, tags });
          await store.saveChanges();
        }
      }
      else if (roll < 0.7) {
        if (mirror.Item[key] !== undefined) await store.entity('Item').delete(key);
      }
      else if (roll < 0.78) {
        const s = KEY_POOL[Math.floor(rand() * KEY_POOL.length)];
        const token = JSON.stringify([s, 'course/one']);
        if (mirror.Grade[token] === undefined) {
          await store.entity('Grade').create({ s, c: 'course/one', v: 1 });
        }
        else {
          await store.entity('Grade').update({ s, c: 'course/one' },
            { v: Math.floor(rand() * 10) });
        }
      }
      else if (roll < 0.85) {
        // a multi-op transaction touching several tables
        await store.transaction(async (tx) => {
          await tx.collection('docs').put(randomDoc(rand, 'txn'), 'txn');
          if (mirror.Item.txn === undefined) {
            await tx.entity('Item').create({ id: 'txn', n: step, on: true });
          }
          else {
            await tx.entity('Item').update('txn', { n: step });
          }
        });
      }
      else if (roll < 0.92) {
        // an aborted transaction must contribute NOTHING
        await store.transaction(async (tx) => {
          await tx.collection('docs').put(randomDoc(rand, 'doomed'), 'doomed');
          throw new Error('abort');
        }).catch(() => {});
      }
      else {
        // a caught inner rollback inside a committed outer
        await store.transaction(async (tx) => {
          await tx.collection('docs').put(randomDoc(rand, 'outer'), 'outer');
          try {
            await tx.transaction(async (inner) => {
              await inner.collection('docs').put(randomDoc(rand, 'inner-ghost'), 'inner-ghost');
              throw new Error('inner');
            });
          }
          catch {
            // survived
          }
        });
      }
    }
    catch (error) {
      // hostile ops may legitimately refuse (duplicate insert races
      // with the mirror when a doomed key collides); refusals must
      // simply not emit — the checkpoint below is the arbiter
      if (!/JD2001|JD2006/.test(String(/** @type {any} */ (error).code))) throw error;
    }
    if (step % 25 === 24) {
      const actual = await stateOf(store);
      assert.ok(deepEquals(mirror, actual),
        `[${mode} seed ${seed}] mirror diverged at step ${step}\n`
        + `mirror: ${JSON.stringify(mirror).slice(0, 400)}\n`
        + `actual: ${JSON.stringify(actual).slice(0, 400)}`);
    }
  }
  const finalActual = await stateOf(store);
  assert.ok(deepEquals(mirror, finalActual),
    `[${mode} seed ${seed}] final state diverged`);
  await store.close();
  return mirror;
}

describe('the round-trip property (seeded corpus)', () => {
  for (const mode of ['session', 'journal']) {
    for (const seed of [0x5eed18, 0xfeedb0, 0xc0ffee]) {
      it(`${mode} mode reproduces the after-state exactly (seed ${seed})`, async () => {
        await runCorpus(mode, seed, 150);
      });
    }
  }

  it('both modes end at the same state for the same seed', async () => {
    const viaSession = await runCorpus('session', 0xd1ff, 100);
    const viaJournal = await runCorpus('journal', 0xd1ff, 100);
    assert.ok(deepEquals(viaSession, viaJournal),
      'the same seeded script must land both modes on the same mirror');
  });
});
