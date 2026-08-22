//@ts-check
/**
 * @file The homepage's living dispatch: a small `$contract` document
 * (`../content/hero.contract.json`) compiled in the browser and
 * DISPATCHED through @jarenjs/contract's local binding, with the
 * artifacts of the real run recorded stage by stage.
 *
 * Nothing here is a timeline. `runHeroDispatch` opens a real client over
 * real handlers, awaits one real `invoke`, and then reads the stages off
 * what that run left behind: the operation the outcome names, the
 * validator's verdict (the accepted input, or the refusal's own code and
 * its errors — each carrying the `schemaPath` of the member at fault
 * inside the document), whether the handler ran and what it answered,
 * what the output validator was given, and the outcome envelope itself.
 * The pipeline is not instrumented and this module does not widen the
 * contract package to instrument it — reading the artifacts of a
 * finished run is why it does not have to. A stage the run cannot show
 * is marked `skipped`, never invented.
 *
 * The local binding resolves an operation by id, not by route, so the
 * match stage names the id the outcome carries and shows the canonical
 * HTTP route the SAME compiled document resolves for it — through
 * `contract.match`, so the two are proven to agree rather than asserted.
 *
 * The view animates the recording; the recording is the truth.
 */

import { compileContract } from '@jarenjs/contract';
import { openLocalClient } from '@jarenjs/contract/local';
import { isJsonValue } from '@jarenjs/core/object';

import heroDoc from '../content/hero.contract.json' with { type: 'json' };
import { formatJson } from '../lib/format.js';

/**
 * The demo document, compiled on first dispatch and kept — an
 * illustration only the home page shows, so no other page pays for it
 * at boot. `op` is the operation the hero dispatches (the document's
 * command) and `routes` is `describe()` by id: both are read OFF the
 * compiled document rather than written down, so the demo follows the
 * document instead of contradicting it.
 * @type {{ contract: any, op: string, routes: Map<string, any> } | null}
 */
let compiled = null;

/** @returns {{ contract: any, op: string, routes: Map<string, any> }} */
export function heroDocument() {
  if (compiled === null) {
    const contract = compileContract(heroDoc);
    compiled = {
      contract,
      op: contract.ids.find((/** @type {string} */ id) => contract.operations[id].kind === 'command')
        ?? contract.ids[0],
      routes: new Map(contract.describe().operations.map((/** @type {any} */ o) => [o.id, o])),
    };
  }
  return compiled;
}

/** The stock numbers the demo catalogue starts out holding. */
const HELD = ['LMP-0007'];

/**
 * One recorded stage of a finished run.
 * @typedef {Object} HeroStage
 * @property {string} key - the pipeline step, in its own order
 * @property {string} title
 * @property {'ok' | 'refused' | 'skipped'} state
 * @property {string} summary - one line, derived from the run
 * @property {string | null} artifact - the stage's own JSON, or null
 */

/**
 * A finished run, as the page holds it. Pure JSON: it lands in app state.
 * @typedef {Object} HeroRun
 * @property {string | null} refusal - why nothing dispatched (the input
 *   was not JSON, or the host itself refused); null for a run that happened
 * @property {string | null} op - the operation the outcome names
 * @property {{ id: string | null, version: string | null } | null} document -
 *   the demo document's own identity, so a consumer of the run needs
 *   nothing else from this module
 * @property {HeroStage[]} stages
 * @property {any} settled - the outcome envelope, verbatim
 * @property {string | null} revision - the document's revision (64 hex)
 * @property {string} binding - the binding's own name
 * @property {boolean} validatedOutput - as the running client publishes it
 */

/**
 * @param {string} key
 * @param {string} title
 * @param {'ok' | 'refused' | 'skipped'} state
 * @param {string} summary
 * @param {any} [artifact] - rendered as JSON when given
 * @returns {HeroStage}
 */
const stage = (key, title, state, summary, artifact) => ({
  key, title, state, summary,
  artifact: artifact === undefined ? null : formatJson(artifact),
});

/** How many members an object value carries; `0` for anything else. */
const members = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value)
  ? Object.keys(value).length
  : 0);

/** `1 violation` / `3 violations` — the count is the run's. */
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * What a handler recorded about its own call — the only observation
 * point this module has, and all it needs: the pipeline stays
 * uninstrumented because a finished outcome says the rest.
 * @typedef {{ ran: boolean, input: any, value: any, failed: boolean }} HandlerRecord
 */

/**
 * The demo document's handler table, with the recorder the save handler
 * writes into. Every declared operation gets one — a binding refuses to
 * open over a table that does not serve them all — and the catalogue is
 * fresh per table, so a re-dispatch of one input answers the same thing
 * twice. One stock number is already held, which is what makes the
 * document's declared conflict reachable by a reader editing the input.
 * @returns {{ handlers: Record<string, any>, seen: HandlerRecord }}
 */
export function heroHandlers() {
  const { op } = heroDocument();
  /** @type {HandlerRecord} */
  const seen = { ran: false, input: null, value: null, failed: false };
  const held = new Set(HELD);
  return {
    seen,
    handlers: {
      'shop.item': (/** @type {any} */ i, /** @type {any} */ ctx) => (held.has(i.sku)
        ? { sku: i.sku, title: 'Ship\'s lamp, oil', price: 38 }
        : ctx.fail('not-found', { sku: i.sku }, { sku: i.sku })),
      [op]: (/** @type {any} */ i, /** @type {any} */ ctx) => {
        seen.ran = true;
        seen.input = isJsonValue(i) ? i : null;
        if (held.has(i.sku)) {
          seen.failed = true;
          return ctx.fail('conflict', { sku: i.sku }, { sku: i.sku });
        }
        held.add(i.sku);
        const value = { sku: i.sku, saved: true, held: held.size };
        seen.value = value;
        return value;
      },
    },
  };
}

/**
 * Build the stage list from what the finished run left behind.
 * @param {any} outcome - the real outcome envelope
 * @param {HandlerRecord} seen - what the handler recorded about its own call
 * @param {any} capabilities - the running client's frozen table
 * @returns {HeroStage[]}
 */
function recordStages(outcome, seen, capabilities) {
  const { contract, routes } = heroDocument();
  const id = outcome.meta.op;
  const op = contract.operations[id];
  const route = routes.get(id);
  const hit = contract.match(route.method, route.path);
  const declared = Object.keys(route.in).length;
  /** A contract-kind outcome the handler never saw is the input validator's. */
  const inputRefused = !outcome.ok && outcome.kind === 'contract' && !seen.ran;
  const violations = Array.isArray(outcome.error?.details) ? outcome.error.details.length : 0;

  const stages = [
    stage('match', 'Match', hit !== null && hit.op.id === id ? 'ok' : 'refused',
      `${route.method} ${route.path} → ${id} · ${op.kind}`,
      {
        operation: id,
        kind: op.kind,
        canonical: `${route.method} ${route.path}`,
        resolves: hit === null ? null : hit.op.id,
        input: route.in,
      }),
  ];

  if (inputRefused) {
    stages.push(stage('input', 'Validate input', 'refused',
      `${outcome.error.code} · ${plural(violations, 'violation')}`,
      { code: outcome.error.code, message: outcome.error.message, details: outcome.error.details }));
    stages.push(stage('handler', 'Handler', 'skipped', 'not reached'));
    stages.push(stage('output', 'Validate output', 'skipped', 'not reached'));
  }
  else {
    stages.push(stage('input', 'Validate input', 'ok',
      `accepted · ${members(seen.input)} of ${declared} declared members`, seen.input));

    if (!seen.ran) {
      // nothing observed the handler, so nothing about it is claimed
      stages.push(stage('handler', 'Handler', 'skipped', 'not reached'));
      stages.push(stage('output', 'Validate output', 'skipped', 'not reached'));
    }
    else if (seen.failed) {
      stages.push(stage('handler', 'Handler', 'refused',
        `declared failure · ${outcome.error?.code ?? ''}`.trim(), outcome.error));
      stages.push(stage('output', 'Validate output', outcome.kind === 'failure' ? 'ok' : 'refused',
        'the declared error\'s details, against its own schema',
        { schema: op.errors[outcome.error?.code]?.schema ?? null, details: outcome.error?.details ?? null }));
    }
    else {
      stages.push(stage('handler', 'Handler', 'ok',
        `answered ${plural(members(seen.value), 'member')}`, seen.value));
      // the verdict is the OUTCOME's: a handler whose value fails the
      // schema it declares settles as a contract refusal, and the stage
      // says so rather than claiming the check it did not pass
      const broke = !outcome.ok && outcome.kind === 'contract';
      stages.push(stage('output', 'Validate output', broke ? 'refused' : 'ok',
        broke
          ? `${outcome.error.code} · ${outcome.error.message}`
          : `validation ${capabilities.validatedOutput ? 'on' : 'off'} · accepted`,
        broke
          ? { code: outcome.error.code, message: outcome.error.message }
          : { validated: capabilities.validatedOutput, schema: heroDoc.operations[id].output }));
    }
  }

  stages.push(stage('outcome', 'Outcome', outcome.ok ? 'ok' : 'refused',
    outcome.ok
      ? `ok · ${plural(members(outcome.value), 'member')}`
      : `${outcome.kind} · ${outcome.error.code}`,
    outcome));
  return stages;
}

/** What a run that never happened says about itself. */
const refused = (reason) => ({
  refusal: reason, op: null, document: null, stages: [], settled: null,
  revision: null, binding: '', validatedOutput: false,
});

/**
 * Run one dispatch and record what it produced. TOTAL: an input that is
 * not JSON, and a host fault of any kind, come back as a run that says
 * why nothing dispatched rather than as a rejection — the page has a
 * hero to render either way.
 * @param {string} text - the input document, as the reader typed it
 * @returns {Promise<HeroRun>}
 */
export async function runHeroDispatch(text) {
  let input;
  try {
    input = JSON.parse(text);
  }
  catch (error) {
    return refused(/** @type {Error} */ (error).message);
  }

  const { contract, op } = heroDocument();
  const { handlers, seen } = heroHandlers();

  let client;
  try {
    // output validation stays ON: it is the alarm this demo exists to
    // show working, and the stage that reports it reads the outcome
    client = openLocalClient(contract, handlers);
  }
  catch (error) {
    // a construction refusal is a defect in this module, not in the
    // reader's input — it says so instead of rendering half a pipeline
    return refused(/** @type {any} */ (error)?.message ?? String(error));
  }
  let outcome;
  try {
    outcome = await client.invoke(op, input);
  }
  catch (error) {
    return refused(/** @type {any} */ (error)?.message ?? String(error));
  }
  finally {
    client.close();
  }

  let revision = null;
  try {
    revision = await contract.revision();
  }
  catch {
    // a host without SubtleCrypto has no digest; the run stands without it
  }

  return {
    refusal: null,
    op: outcome.meta.op,
    document: { id: contract.id, version: contract.version },
    stages: recordStages(outcome, seen, client.capabilities),
    settled: outcome,
    revision,
    binding: client.capabilities.name,
    validatedOutput: client.capabilities.validatedOutput,
  };
}
