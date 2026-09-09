//@ts-check
/** Original hierarchical fixture. Scripted models prove accounting, not model intelligence. */
import { createEnvironment, createLedger, createLongHorizonAgent, createProgramAuthor,
  createProgramRunner, createStructuredOutput, createChatClient } from '@jarenjs/ai';
import { compileJsonQuery, analyzeQuery, annotateTypes } from '@jarenjs/json/query';
import { contentHash } from './authoring.js';
import { readAiEnv } from './env.js';

/** Leaf revisions combine into sections and section totals into a regional comparison.
 * @param {number} [seed] */
export function hierarchicalCorpus(seed = 17) {
  const sections = [];
  const expected = { north: 0, south: 0, evidence: [] };
  for (let region = 0; region < 2; region++) {
    for (let section = 0; section < 3; section++) {
      const leaves = [];
      for (let leaf = 0; leaf < 4; leaf++) {
        const id = `${region === 0 ? 'N' : 'S'}${section}-${leaf}`;
        const value = (seed * (leaf + 3) + section * 11 + region * 19) % 97;
        const record = { region: region === 0 ? 'north' : 'south', section, id,
          revisions: [{ revision: 0, accepted: false, credit: 9999, debit: 0 },
            { revision: 1, accepted: true, credit: value + 7, debit: 7 }],
          note: 'Old revisions and rejected amounts are distractors. Only the accepted revision contributes.' };
        expected[record.region] += value; expected.evidence.push(id); leaves.push(record);
      }
      sections.push({ region, section, leaves });
    }
  }
  const text = sections.map((section) => section.leaves.map((leaf) => JSON.stringify(leaf)).join('\n')).join('\n\n');
  return { seed, license: 'MIT; original repository fixture', sections, text,
    question: 'For every leaf use only the accepted revision. Sum credit minus debit per section, then per region. Return north and south totals and all contributing leaf ids in evidence.',
    expected, hash: contentHash(text) };
}

/** One answer checker for every depth and provider. @param {any} result @param {any} corpus */
export function scoreHierarchy(result, corpus) {
  let value;
  try { value = JSON.parse(result.answer?.text ?? 'null')?.value; } catch { value = null; }
  const evidence = new Set([].concat(value?.evidence ?? []));
  const hits = corpus.expected.evidence.filter((id) => evidence.has(id)).length;
  return { correct: result.ok === true && value?.north === corpus.expected.north && value?.south === corpus.expected.south
    && hits === corpus.expected.evidence.length && evidence.size === hits,
  evidenceRecall: hits / corpus.expected.evidence.length };
}

/** Structural program shared by the fixture's authors at each level. @param {number} depth */
export function hierarchyProgram(depth) {
  return { steps: [
    { op: 'chunk', from: 'corpus', as: 'pieces', strategy: 'line', size: [6000, 2000, 700, 200][depth] },
    { op: 'map', from: 'pieces', as: 'found', prompt: 'Use only accepted revisions. Return {north:sum of credit minus debit for north,south:sum for south,evidence:all contributing leaf ids}. Never count rejected revisions.' },
    { op: 'reduce', from: 'found', as: 'totals', query: { slot: 'corpus', value: {
      north: { $sum: '$[*].value.north' }, south: { $sum: '$[*].value.south' },
      evidence: [{ $distinct: '$[*].value.evidence[*]' }],
    } } },
    { op: 'answer', from: 'totals', chars: 8000 },
  ] };
}

/** Scripted extraction solves all visible leaves independently of depth.
 * @param {any} request */
function extract(request) {
  const text = request.messages.at(-1).content.split(/--- piece [^\n]+ ---\n/)[1] ?? '';
  const value = { north: 0, south: 0, evidence: [] };
  for (const line of text.split('\n').filter(Boolean)) {
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    const revision = record.revisions?.find((item) => item.accepted);
    if (revision) { value[record.region] += revision.credit - revision.debit; value.evidence.push(record.id); }
  }
  return value;
}

/** Measure one tree; telemetry separates author and leaf phases.
 * @param {{ depth: number, seed?: number, profile?: any, client?: any, maxCalls?: number }} options */
export async function hierarchyProbe(options) {
  const corpus = hierarchicalCorpus(options.seed);
  const environment = createEnvironment({ ledger: createLedger() });
  await environment.put('corpus', corpus.text, { kind: 'text' });
  const routes = [];
  const base = options.client ?? { endpoint: { provider: 'openrouter' }, complete: async () => { throw new Error('unselected client'); } };
  const selectModel = (context) => ({ identity: options.profile?.name ?? 'fixture', client: options.client ?? {
    endpoint: base.endpoint, complete: async (request) => ({
      message: { content: JSON.stringify(context.purpose === 'author' ? hierarchyProgram(context.depth) : extract(request)) },
      usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50, completion_tokens_details: { reasoning_tokens: 0 } },
    }),
  } });
  const agent = createLongHorizonAgent({ client: base, environment, compileQuery: compileJsonQuery,
    analyzeQuery, annotateTypes, createEnvironment, createStructuredOutput, createProgramAuthor, createProgramRunner,
    depth: options.depth, budget: { turns: options.maxCalls ?? 200 }, selectModel,
    limits: options.profile?.limits ?? { deadlineMs: 30000, outputTokens: 2048, reasoningTokens: 512 },
    onRoute: (event) => routes.push(event), maxConcurrentSubcalls: 2, maxSubcalls: 100,
  });
  const started = performance.now();
  const result = await agent.run(corpus.question);
  const score = scoreHierarchy(result, corpus);
  return { mode: options.client ? 'live' : 'deterministic', measuredAt: options.client ? new Date().toISOString() : 'fixture',
    providerVersion: null, seed: corpus.seed, corpusHash: corpus.hash,
    depth: options.depth, profile: options.profile?.name ?? 'fixture', provider: options.profile?.provider ?? 'scripted',
    model: options.profile?.model ?? 'fixture', ...score, authorCalls: routes.filter((row) => row.purpose === 'author').length,
    subcalls: routes.filter((row) => row.purpose === 'subcall').length, tokens: result.spent.tokens,
    ms: options.client ? performance.now() - started : routes.length,
    timeouts: routes.filter((row) => row.outcome === 'timeout').length,
    budgetExhausted: result.stopReason?.startsWith('budget-') ?? false, stopReason: result.stopReason,
    routes: routes.map((row) => options.client ? row : { ...row, ms: 1 }),
    errors: result.errors ?? [] };
}

/** Live profiles use the same source, question, checker and limits at every depth.
 * @param {{ live?: boolean }} [options] */
export async function hierarchicalScorecard(options = {}) {
  const rows = [];
  const env = readAiEnv();
  const profiles = options.live ? [
    { name: 'primary', provider: env.provider, model: env.model },
    { name: 'secondary', provider: env.provider, model: env.modelStrong },
  ] : [null];
  let remaining = env.maxCalls;
  for (const profile of profiles) {
    for (const seed of options.live ? [17] : [17, 29]) {
      for (const depth of [0, 1, 2, 3]) {
        if (options.live && (!env.live || remaining === 0)) {
          rows.push({ profile: profile.name, depth, outcome: 'skipped', reason: env.reason ?? 'maxCalls' }); continue;
        }
        const client = profile ? createChatClient({ ...env, model: profile.model, maxTokens: 2048,
          reasoning: { max_tokens: 512 }, retry: { attempts: 1 } }) : undefined;
        const row = await hierarchyProbe({ depth, seed, profile, client, maxCalls: options.live ? Math.min(remaining, 12) : 200 });
        remaining -= row.authorCalls + row.subcalls;
        rows.push(row);
      }
    }
  }
  return { version: 1, mode: options.live ? 'live' : 'deterministic',
    corpus: { seeds: options.live ? [17] : [17, 29], regions: 2, sections: 6, leaves: 24, license: 'MIT; original repository fixture' },
    decisionBar: { correctnessGain: 0.1, maximumCallMultiplier: 2, requiresLiveEvidence: true },
    decision: 'Depth remains 1 by default; scripted traversal cannot establish a model-quality gain.', rows };
}
