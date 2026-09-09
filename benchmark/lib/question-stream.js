//@ts-check
/** Authored fixture labels judge suitability; similarity only proposes a candidate. */
import { createLedger, createHashEmbedder, createEnvironment, createProgramRunner,
  programGate, createProgramSession, createProgramAuthor, createStructuredOutput,
  createChatClient, createBudgetAccount } from '@jarenjs/ai';
import { compileJsonQuery } from '@jarenjs/json/query';
import { readAiEnv } from './env.js';

const DATA = [{ value: 4, active: true }, { value: 9, active: false }, { value: 2, active: true }];
const FAMILIES = [
  ['sum', 'total value of all records', { $sum: '$[*].value' }, 15],
  ['max', 'highest value of all records', { $max: '$[*].value' }, 9],
  ['min', 'lowest value of all records', { $min: '$[*].value' }, 2],
  ['count', 'number of all records', { $count: '$[*]' }, 3],
  ['active', 'total value of active records', { $sum: { $for: { r: '$[*]' }, $where: '$r.active', $return: '$r.value' } }, 6],
];

/** Seeded stream: repeats, paraphrases, close traps and unrelated work.
 * @param {number} [seed] */
export function questionStream(seed = 20260909) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const rows = [];
  for (let round = 0; round < 5; round++) {
    const order = FAMILIES.map((family) => ({ family, sort: next() })).sort((a, b) => a.sort - b.sort);
    for (const { family: [family, words, query, expected] } of order) {
      rows.push({ id: `q${rows.length}`, family, expected,
        class: round === 0 ? 'unrelated' : family === 'active' || family === 'min' ? 'near-wrong' : 'repeated',
        question: `${round % 2 === 0 ? 'What is' : 'Please find'} the ${words}?`,
        program: { steps: [{ op: 'select', from: 'data', as: 'result', query }, { op: 'answer', from: 'result' }] },
      });
    }
  }
  return rows;
}

/** Measure the entire candidate path, including a wrong execution and fresh fallback.
 * Times and tokens are a declared scripted cost model, not wall-clock observations.
 * @param {{ threshold?: number|null, dims?: number, seed?: number, authorTokens?: number,
 *   authorMs?: number, stale?: boolean }} [options] */
export async function simulateQuestionStream(options = {}) {
  const { threshold = null, dims = 64, seed = 20260909, authorTokens = 200, authorMs = 500 } = options;
  const embedder = createHashEmbedder({ dims });
  const ledger = createLedger({ embedder, now: () => '2026-09-09T00:00:00Z' });
  const environment = createEnvironment({ ledger });
  await environment.put('data', JSON.stringify(DATA), { kind: 'json' });
  const runner = createProgramRunner({ environment, compileQuery: compileJsonQuery });
  const rows = [];
  const families = new Map();
  for (const item of questionStream(seed)) {
    const row = { id: item.id, family: item.family, class: item.class, selectedFamily: null,
      score: null, eligible: families.has(item.family), correctReuse: 0, falseReuse: 0, rejectedReuse: 0,
      authorCalls: 0, fallbackCalls: 0, retrievalCalls: 0, executions: 0, correct: false, ms: 0, tokens: 0 };
    let result;
    let selected = false;
    if (threshold !== null) {
      row.retrievalCalls++; row.ms += 2; row.tokens += 5;
      const recalled = await ledger.recallSkills({ near: item.question, limit: 1, minScore: threshold });
      if ('skills' in recalled && recalled.skills.length > 0) {
        selected = true;
        const skill = recalled.skills[0];
        row.score = recalled.scores[0]; row.selectedFamily = skill.name;
        const doc = JSON.parse(skill.instructions);
        if (options.stale === true && rows.length === 5) doc.steps[0].from = 'retired';
        const gate = programGate({ compileQuery: compileJsonQuery, known: ['data'] })(doc);
        row.ms++;
        if (gate !== true) row.rejectedReuse++;
        else {
          result = await runner.run(doc); row.executions++; row.ms++;
          if (result.ok && JSON.parse(result.answer.text) === item.expected && skill.name === item.family) row.correctReuse++;
          else { row.falseReuse++; result = null; }
        }
      }
    }
    if (!result?.ok) {
      row.authorCalls++; row.fallbackCalls += selected ? 1 : 0;
      row.tokens += authorTokens; row.ms += authorMs;
      result = await runner.run(item.program); row.executions++; row.ms++;
    }
    row.correct = result.ok && JSON.parse(result.answer.text) === item.expected;
    if (row.correct && !families.has(item.family)) {
      const embedding = Array.from((await embedder.embed([item.question]))[0]);
      const stored = await ledger.addSkill({ name: item.family, when: item.question,
        instructions: JSON.stringify(item.program), embedding,
        embeddedBy: { model: embedder.model, dims }, tools: [] });
      if ('error' in stored) throw new Error(stored.error);
      families.set(item.family, stored.id);
    }
    rows.push(row);
  }
  const sum = (key) => rows.reduce((total, row) => total + Number(row[key]), 0);
  const correctReuse = sum('correctReuse');
  const falseReuse = sum('falseReuse');
  return { threshold, dims, mode: 'deterministic', costModel: { authorTokens, authorMs, retrievalTokens: 5, retrievalMs: 2, executionMs: 1 },
    questions: rows.length, correctReuse, falseReuse, rejectedReuse: sum('rejectedReuse'),
    precision: correctReuse / (correctReuse + falseReuse || 1), recall: correctReuse / (sum('eligible') || 1),
    accuracy: sum('correct') / rows.length, authorCalls: sum('authorCalls'), fallbackCalls: sum('fallbackCalls'),
    tokens: sum('tokens'), ms: sum('ms'), rows };
}

/** The measured frontier; selection is cost-minimal at baseline correctness with a checker. */
export async function questionStreamScorecard(options = {}) {
  if (options.live) return liveQuestionStream();
  const baseline = await simulateQuestionStream();
  const frontier = [];
  for (const dims of [32, 64, 128]) {
    for (const threshold of [0, 0.5, 0.75, 0.9, 0.95, 1]) {
      frontier.push(await simulateQuestionStream({ dims, threshold }));
    }
  }
  const selected = frontier.filter((row) => row.accuracy === baseline.accuracy)
    .sort((a, b) => a.tokens - b.tokens || a.falseReuse - b.falseReuse || b.threshold - a.threshold || a.dims - b.dims)[0];
  return { version: 1, seed: 20260909, baseline, frontier,
    runtime: await runtimeQuestionStream({ threshold: selected.threshold, dims: selected.dims }),
    selected: { threshold: selected.threshold, dims: selected.dims, requiresOutcomeChecker: true,
      basis: 'minimum total tokens at baseline accuracy; then fewer wrong executions, higher threshold, fewer dimensions' } };
}

/** Small live stream over the same fixture: fresh and reuse both pay actual author costs.
 * Live rows are bounded globally, retain failures, and never select the fixture threshold.
 * @returns {Promise<any>} */
export async function liveQuestionStream() {
  const env = readAiEnv();
  const corpus = questionStream();
  const repeated = corpus.find((item) => item.family === 'sum');
  const active = corpus.find((item) => item.family === 'active');
  const stream = [repeated, { ...repeated, question: repeated.question.replace('What is', 'Please find') }, active, repeated];
  const labels = new Map(stream.map((item) => [item.question, item.family]));
  const rows = [];
  let remaining = env.maxCalls;
  for (const [name, model] of [['primary', env.model], ['secondary', env.modelStrong]]) {
    for (const mode of ['fresh', 'reuse']) {
      const embedder = createHashEmbedder({ dims: 32 });
      const ledger = createLedger({ embedder });
      const environment = createEnvironment({ ledger });
      await environment.put('data', JSON.stringify(DATA), { kind: 'json' });
      const account = createBudgetAccount({ turns: Math.max(0, remaining) });
      const routes = [];
      const options = { environment, compileQuery: compileJsonQuery, createStructuredOutput,
        client: createChatClient({ ...env, model, retry: { attempts: 1 } }),
        account, maxRepairs: 0, limits: { deadlineMs: 30000, outputTokens: 4096, reasoningTokens: 512 },
        onRoute: (event) => routes.push(event),
        system: 'Author a program over data, a JSON array of {value:number,active:boolean}. Use select then answer. Sum uses {"$sum":"$[*].value"}; active-only uses {"$sum":{"$for":{"r":"$[*]"},"$where":"$r.active","$return":"$r.value"}}. Program example: {"steps":[{"op":"select","from":"data","as":"result","query":{"$sum":"$[*].value"}},{"op":"answer","from":"result"}]}. Return only JSON.',
      };
      let current;
      const session = createProgramSession({ ...options, author: createProgramAuthor(options),
        ...(mode === 'reuse' ? { reuse: { environmentId: 'question-stream-live-v1', schemaVersion: 'program-v1',
          embedder, threshold: DEFAULT_LIVE_THRESHOLD,
          accept: ({ skill }) => labels.get(skill.program.question) === current.family,
          check: ({ result }) => result.ok && JSON.parse(result.answer.text) === current.expected } } : {}),
      });
      for (const [index, item] of stream.entries()) {
        if (!env.live || remaining <= 0) {
          rows.push({ name, model, mode, index, outcome: 'skipped', reason: env.reason ?? 'maxCalls' }); continue;
        }
        current = item;
        const before = routes.length;
        const started = performance.now();
        let result;
        try { result = await session.run(item.question); }
        catch { result = { ok: false }; }
        const calls = routes.slice(before);
        remaining -= calls.length;
        let correct = false;
        try { correct = result.ok && JSON.parse(result.answer.text) === item.expected; } catch { /* Failed answer stays false. */ }
        rows.push({ profile: name, provider: env.provider, providerVersion: null, model, mode, index,
          measuredAt: new Date().toISOString(), family: item.family, question: item.question,
          correct, outcome: correct ? 'correct' : 'failed', reused: result.reuse?.reused ?? false,
          fallback: result.reuse?.fallback ?? false, events: result.reuse?.events ?? [],
          authorCalls: calls.filter((call) => call.purpose === 'author').length,
          tokens: calls.reduce((sum, call) => sum + (call.usage?.total_tokens ?? 0), 0),
          usageComplete: calls.every((call) => call.usage !== null), ms: performance.now() - started, routes: calls,
        });
      }
    }
  }
  return { version: 1, mode: 'live', threshold: DEFAULT_LIVE_THRESHOLD,
    suitability: 'fixture family proof and outcome checker; no general language claim', rows };
}

const DEFAULT_LIVE_THRESHOLD = 0.9;

/** Remeasure the shipped pipeline at the selected fixture threshold.
 * @param {{threshold: number, dims: number}} policy */
export async function runtimeQuestionStream(policy) {
  const corpus = questionStream();
  const families = new Map(corpus.map((item) => [item.question, item.family]));
  const embedder = createHashEmbedder({ dims: policy.dims });
  const ledger = createLedger({ embedder, now: () => '2026-09-09T00:00:00Z' });
  const environment = createEnvironment({ ledger });
  await environment.put('data', JSON.stringify(DATA), { kind: 'json' });
  const rows = [];
  let current;
  const session = createProgramSession({ environment, compileQuery: compileJsonQuery,
    author: { author: async () => ({ value: current.program, attempts: 1 }) },
    reuse: { ...policy, embedder, environmentId: 'question-stream-v1', schemaVersion: 'program-v1',
      accept: ({ skill }) => families.get(skill.program.question) === current.family,
      check: ({ result }) => result.ok && JSON.parse(result.answer.text) === current.expected },
  });
  for (const item of corpus) {
    current = item;
    const result = await session.run(item.question);
    rows.push({ id: item.id, correct: result.ok, reused: result.reuse.reused,
      authorCalls: result.reuse.authorCalls, fallbackCalls: result.reuse.fallback ? 1 : 0,
      rejectedReuse: result.reuse.events.filter((event) => event.kind === 'rejected').length });
  }
  const authorCalls = rows.reduce((sum, row) => sum + row.authorCalls, 0);
  return { mode: 'deterministic', ...policy, questions: rows.length,
    accuracy: rows.filter((row) => row.correct).length / rows.length,
    correctReuse: rows.filter((row) => row.reused).length, authorCalls,
    tokens: authorCalls * 200 + rows.length * 5,
    suitability: 'fixture family proof plus outcome checker', rows };
}
