//@ts-check
/**
 * @file Migrations without a database: the same `jslt` transforms and
 * `query` assertions a Store applies to its tables, applied to
 * documents a caller already holds or can stream past once.
 *
 * Two surfaces, because they cost different things and a caller should
 * have to say which it is buying. {@link migrateDocuments} takes arrays
 * and answers arrays: the source is REWINDABLE, so it runs the steps
 * exactly as the Store does — every step over every document, in step
 * order — and therefore refuses on exactly the step the Store would
 * refuse on. {@link streamDocuments} takes anything iterable once and
 * writes each document out as it finishes: bounded, and honest that a
 * single pass cannot look ahead (see its own note).
 *
 * A physical step — rendered DDL, a data statement spelled as SQL, the
 * table-rebuild procedure, the stored-derived-column backfill — has no
 * meaning without tables. Neither surface skips one: both refuse, by
 * name, before they ask the source for its first document.
 */

import { resolveRuntime } from '@jarenjs/core/runtime';
import { setObjectMember } from '@jarenjs/core/object';
import { compileJsonQuery } from '@jarenjs/json/query';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';

import { DbCompileError } from './errors.js';
import { refuseCancelled } from './cancellation.js';
import {
  compileDocumentStep, checkMigrationDocument, PHYSICAL_STEP_KINDS, DOCUMENT_STEP_KINDS,
  normalizeAssertionBounds, createAssertionBoundGuard,
} from './document-steps.js';

/**
 * Compile every migration's document steps and refuse, before any
 * document is read, anything this host cannot honour.
 * @param {any[]} migrations
 * @param {Set<string>} present - the collections the caller supplied
 * @param {{ compileJslt: Function, compileQuery: Function, keys: Record<string, string[]> }} context
 * @returns {{ id: string, to: string, from: string, operations: any[] }[]}
 */
function planStorelessRun(migrations, present, context) {
  if (!Array.isArray(migrations))
    throw new TypeError('a document migration needs the ordered migration list');
  const plans = [];
  for (const migration of migrations) {
    checkMigrationDocument(migration);
    // the whole refusal happens here, before the first document: a
    // half-applied migration is the one outcome a runner without a
    // transaction can never take back
    for (let i = 0; i < migration.steps.length; i++) {
      const step = migration.steps[i];
      if (PHYSICAL_STEP_KINDS.has(step.kind)) {
        throw new DbCompileError('JD0023',
          `migration '${migration.id}' step ${i} (${step.kind}) needs a database: a `
          + 'document runner has no tables to change. Run this migration against a '
          + 'store, or split the physical steps out of it');
      }
      if (!DOCUMENT_STEP_KINDS.has(step.kind)) {
        throw new DbCompileError('JD0023',
          `migration '${migration.id}' step ${i} has no recognised kind`);
      }
      if (!present.has(step.collection)) {
        throw new DbCompileError('JD0023',
          `migration '${migration.id}' step ${i} (${step.kind}) names collection `
          + `'${step.collection}', which was not supplied`);
      }
    }
    plans.push({
      id: migration.id,
      from: migration.from,
      to: migration.to,
      operations: migration.steps.map((step, i) => compileDocumentStep(step, i, {
        migrationId: migration.id,
        compileJslt: context.compileJslt,
        compileQuery: context.compileQuery,
        keys: Object.hasOwn(context.keys, step.collection) ? (context.keys[step.collection] ?? []) : [],
      })),
    });
  }
  return plans;
}

/** The shared option surface both surfaces read. */
function runContext(options) {
  const runtime = resolveRuntime(options.runtime);
  return {
    batchSize: options.batchSize ?? 500,
    onProgress: options.onProgress,
    keys: options.keys ?? {},
    compileJslt: options.compileJslt ?? compileJsltStylesheet,
    compileQuery: options.compileQuery ?? compileJsonQuery,
    assertionBounds: normalizeAssertionBounds(options.assertionBounds),
    check: () => refuseCancelled({ signal: options.signal, deadline: options.deadline },
      runtime.now, {
        abortCode: 'JD2080', aborted: 'its next step', passed: 'its next step',
        ran: 'no further step ran; a document migration leaves the documents it has '
          + 'already written where they are',
      }),
  };
}

/** The report both surfaces answer with, before its counts are filled. */
const emptyReport = (plans) => ({
  applied: plans.map((plan) => plan.id),
  skipped: [],
  shape: plans.length > 0 ? plans[plans.length - 1].to : null,
  counts: /** @type {Record<string, any>} */ ({}),
  strategy: /** @type {Record<string, string>} */ ({}),
});

/** The per-collection counters a report carries. */
const countersFor = (report, collection) => {
  if (!Object.hasOwn(report.counts, collection))
    setObjectMember(report.counts, collection, { read: 0, transformed: 0, asserted: 0 });
  return report.counts[collection];
};

/**
 * Migrate documents held in memory: `{ users: [...] }` in, the migrated
 * `{ users: [...] }` out, alongside the report.
 *
 * The source is rewindable, so the steps run exactly as a Store runs
 * them — every step over the whole collection, in step order — which is
 * what makes this mode's answer, and its refusal, identical to the
 * Store's for the same migration and the same documents.
 *
 * @param {Record<string, any[]>} collections - the documents, per collection
 * @param {any[]} migrations - the ordered migration list
 * @param {{
 *   batchSize?: number,
 *   onProgress?: Function,
 *   keys?: Record<string, string[]>,
 *   compileJslt?: Function,
 *   compileQuery?: Function,
 *   runtime?: any,
 *   signal?: AbortSignal,
 *   deadline?: number,
 * }} [options]
 * @returns {Promise<{ documents: Record<string, any[]>, report: any }>}
 */
export async function migrateDocuments(collections, migrations, options = {}) {
  if (collections === null || typeof collections !== 'object' || Array.isArray(collections))
    throw new TypeError('migrateDocuments needs { [collection]: document[] }');
  for (const [name, documents] of Object.entries(collections)) {
    if (!Array.isArray(documents))
      throw new TypeError(`migrateDocuments needs an array for collection '${name}'`);
  }
  const context = runContext(options);
  const plans = planStorelessRun(migrations, new Set(Object.keys(collections)), context);
  context.check();

  /** @type {Record<string, any[]>} */
  const state = {};
  for (const [name, documents] of Object.entries(collections)) setObjectMember(state, name, [...documents]);
  const report = emptyReport(plans);
  for (const name of Object.keys(state)) {
    countersFor(report, name).read = state[name].length;
    setObjectMember(report.strategy, name, 'materialized');
  }

  for (const plan of plans) {
    for (const operation of plan.operations) {
      context.check();
      const documents = state[operation.collection];
      const counters = countersFor(report, operation.collection);
      if (operation.kind === 'jslt') {
        for (let i = 0; i < documents.length; i++) {
          documents[i] = operation.apply(documents[i], i);
          counters.transformed++;
          if ((i + 1) % context.batchSize === 0) {
            context.onProgress?.({ migration: plan.id, collection: operation.collection,
              transformed: counters.transformed });
          }
        }
        if (documents.length % context.batchSize !== 0) {
          context.onProgress?.({ migration: plan.id, collection: operation.collection,
            transformed: counters.transformed });
        }
        continue;
      }
      if (operation.fold !== null) {
        // an associative aggregate: the same batches, combined
        let accumulated = operation.fold.start();
        for (let at = 0; at < documents.length; at += context.batchSize) {
          context.check();
          accumulated = operation.fold.combine(accumulated,
            documents.slice(at, at + context.batchSize));
          counters.asserted += Math.min(context.batchSize, documents.length - at);
          context.onProgress?.({ migration: plan.id, collection: operation.collection,
            asserted: counters.asserted });
        }
        operation.fold.finish(accumulated);
        continue;
      }
      if (!operation.perDocument) {
        // materializing: this mode already holds the collection, but the
        // bound is what the caller was promised, so it is checked
        const guard = createAssertionBoundGuard(context.assertionBounds, operation.collection,
          `the assertion of migration '${plan.id}'`);
        for (const document of documents) guard.admit(document);
        operation.assert(documents);
        continue;
      }
      // per-document: the same keyset-sized batches the Store asserts
      // over, so a refusal counts the same violations it counts there
      for (let at = 0; at < documents.length; at += context.batchSize) {
        context.check();
        const batch = documents.slice(at, at + context.batchSize);
        operation.assert(batch);
        counters.asserted += batch.length;
        context.onProgress?.({ migration: plan.id, collection: operation.collection,
          asserted: counters.asserted });
      }
    }
  }
  return { documents: state, report };
}

/**
 * Migrate documents the caller can only walk once, writing each out as
 * it finishes. The source is consumed exactly once and nothing beyond
 * one batch is held, so a collection larger than memory still migrates.
 *
 * **What a single pass cannot do.** The Store, and {@link migrateDocuments},
 * run each step over the whole collection before the next step begins,
 * so when two different steps would each refuse, the EARLIER step
 * refuses first. One pass carries each batch through every step, so the
 * later step can refuse first. Both refuse, with the same code and the
 * same words; only which step is named can differ. A caller who needs
 * that identity has a rewindable source and should use
 * {@link migrateDocuments}.
 *
 * A cross-document assertion (`$count`, `$let`, `$distinct`, a nested
 * `$for`) needs every document at once and so cannot run in one pass;
 * it is refused here by name rather than silently buffering the
 * collection.
 *
 * @param {Record<string, Iterable<any> | AsyncIterable<any>>} sources
 * @param {any[]} migrations - the ordered migration list
 * @param {{
 *   write: (collection: string, document: any) => any,
 *   batchSize?: number,
 *   onProgress?: Function,
 *   keys?: Record<string, string[]>,
 *   compileJslt?: Function,
 *   compileQuery?: Function,
 *   runtime?: any,
 *   signal?: AbortSignal,
 *   deadline?: number,
 * }} options
 * @returns {Promise<any>} the report
 */
export async function streamDocuments(sources, migrations, options) {
  if (sources === null || typeof sources !== 'object' || Array.isArray(sources))
    throw new TypeError('streamDocuments needs { [collection]: iterable }');
  if (options === null || typeof options !== 'object' || typeof options.write !== 'function')
    throw new TypeError('streamDocuments needs { write(collection, document) }');
  const context = runContext(options);
  const plans = planStorelessRun(migrations, new Set(Object.keys(sources)), context);

  // the second refusal a single pass owes before it reads anything: a
  // MATERIALIZING assertion. An associative aggregate is not one — its
  // batches combine, so a single pass answers it exactly.
  for (const plan of plans) {
    for (const operation of plan.operations) {
      if (operation.kind === 'query' && operation.strategy === 'materialize') {
        operation.fail('a cross-document assertion needs every document of '
          + `'${operation.collection}' at once, which a single pass does not hold — `
          + 'migrate this collection from a rewindable source');
      }
    }
  }
  context.check();

  const report = emptyReport(plans);
  // one collection's whole ordered pipeline: every migration's steps
  // over it, in order, applied to each document as it passes
  /** @type {Record<string, any[]>} */
  const pipeline = Object.create(null);
  for (const plan of plans) {
    for (const operation of plan.operations) {
      (pipeline[operation.collection] ??= []).push({
        migration: plan.id, operation, accumulated: undefined, folded: false,
      });
    }
  }

  for (const name of Object.keys(sources)) {
    const counters = countersFor(report, name);
    setObjectMember(report.strategy, name, 'streamed');
    const stages = pipeline[name] ?? [];
    /** @type {any[]} */
    let batch = [];
    const flush = async () => {
      if (batch.length === 0) return;
      context.check();
      for (const stage of stages) {
        if (stage.operation.kind === 'jslt') {
          for (let i = 0; i < batch.length; i++) {
            batch[i] = stage.operation.apply(batch[i], counters.read - batch.length + i);
            counters.transformed++;
          }
          context.onProgress?.({ migration: stage.migration, collection: name,
            transformed: counters.transformed });
          continue;
        }
        if (stage.operation.fold !== null) {
          stage.accumulated = stage.operation.fold.combine(
            stage.accumulated ?? stage.operation.fold.start(), batch);
          stage.folded = true;
        }
        else stage.operation.assert(batch);
        counters.asserted += batch.length;
        context.onProgress?.({ migration: stage.migration, collection: name,
          asserted: counters.asserted });
      }
      for (const document of batch) await options.write(name, document);
      batch = [];
    };
    for await (const document of sources[name]) {
      counters.read++;
      batch.push(document);
      if (batch.length >= context.batchSize) await flush();
    }
    await flush();
    // a fold's verdict is on the TOTAL, so it is reached once the source
    // is spent — an empty source still folds, to its aggregate's identity
    for (const stage of stages) {
      if (stage.operation.fold === null) continue;
      stage.operation.fold.finish(stage.folded ? stage.accumulated : stage.operation.fold.start());
    }
  }
  return report;
}
