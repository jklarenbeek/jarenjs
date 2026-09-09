//@ts-check
/** Authoring evidence retains every attempt, but never provider content or credentials. */
import { createHash } from 'node:crypto';
import { createStructuredOutput } from '@jarenjs/ai/structured';

/** Stable content identity. @param {any} value */
export const contentHash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Preserve historical aggregate evidence without inventing missing per-call provenance.
 * @param {any} artifact */
export function legacyAuthoringEvidence(artifact) {
  return {
    version: 1,
    sourceHash: contentHash(artifact),
    measuredAt: artifact.meta?.date ?? artifact.meta?.timestamp ?? null,
    model: artifact.meta?.model ?? null,
    authoring: artifact.meta?.authoring ?? null,
    provenance: 'legacy-aggregate',
    missing: ['providerVersion', 'sampling', 'schemaBytes', 'deadlineMs', 'attempts'],
  };
}

/** Measure one probe with bounded calls and phase-specific rows.
 * @param {{ client: any, profile: any, grammar: string, schema: any, refs?: any[],
 *   gate?: any, messages: any[], check?: (value: any) => boolean | Promise<boolean>,
 *   maxRepairs?: number, clock?: () => number, measuredAt?: string,
 *   phase?: string, signal?: AbortSignal }} options */
export async function measureAuthoring(options) {
  const { profile, client, schema } = options;
  const clock = options.clock ?? performance.now.bind(performance);
  const deadlineMs = profile.deadlineMs ?? 30000;
  const rows = [];
  const measured = {
    endpoint: client.endpoint,
    async complete(request) {
      const row = {
        attempt: rows.length + 1, phase: options.phase ?? 'author', grammar: options.grammar,
        profile: profile.name, capability: profile.capability ?? null,
        provider: profile.provider, providerVersion: profile.providerVersion ?? null,
        model: profile.model, measuredAt: options.measuredAt ?? new Date().toISOString(),
        sampling: profile.sampling ?? {}, schemaBytes: Buffer.byteLength(JSON.stringify(schema)),
        schemaHash: contentHash(schema), requestHash: contentHash(request.messages),
        deadlineMs, streamed: true, ms: 0, finishReason: null,
        usage: { prompt: null, output: null, reasoning: null, total: null },
        responseHash: null, outcome: 'provider', codes: [],
      };
      rows.push(row);
      const controller = new AbortController();
      const signal = request.signal === undefined ? controller.signal
        : AbortSignal.any([request.signal, controller.signal]);
      let timer;
      const started = clock();
      try {
        const reply = await Promise.race([
          Promise.resolve().then(() => client.complete({ ...request, ...profile.sampling,
            model: profile.model, stream: true, signal })),
          new Promise((_, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error('authoring deadline')); }, deadlineMs);
          }),
        ]);
        const usage = reply.usage ?? {};
        row.finishReason = reply.finishReason ?? null;
        row.usage = {
          prompt: usage.prompt_tokens ?? null, output: usage.completion_tokens ?? null,
          reasoning: usage.completion_tokens_details?.reasoning_tokens ?? null,
          total: usage.total_tokens ?? null,
        };
        row.responseHash = contentHash(reply.message?.content ?? '');
        return reply;
      }
      catch (error) {
        row.outcome = controller.signal.aborted ? 'timeout' : (signal.aborted ? 'aborted' : 'provider');
        throw error;
      }
      finally { clearTimeout(timer); row.ms = Math.max(0, clock() - started); }
    },
  };
  try {
    const result = await createStructuredOutput({
      client: measured, schema, refs: options.refs, gate: options.gate,
      name: `jaren_${options.grammar}`, strict: false, stream: true,
      maxRepairs: options.maxRepairs ?? 0,
      onAttempt(event) {
        const row = rows.at(-1);
        row.codes = event.errors.map((error) => error.code).filter(Boolean);
        row.outcome = event.outcome === 'gate' && row.codes.some((code) => /^(AI02|JQ)/.test(code))
          ? 'compile' : event.outcome;
      },
    }).generate(options.messages, { signal: options.signal });
    if (result.value !== undefined) {
      rows.at(-1).outcome = options.check === undefined ? 'valid'
        : (await options.check(result.value) === true ? 'correct' : 'wrong');
    }
  }
  catch { /* The failed attempt is already retained with its category. */ }
  return rows;
}
