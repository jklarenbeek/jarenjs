//@ts-check
/** Verified, opt-in reuse. Retrieval proposes; the host and current compiler decide. */
import { createProgramAuthor, createProgramRunner, programGate } from './program.js';
import { checkOutcome } from './check.js';

/** The fixture frontier requires an outcome checker; hosts must remeasure other embedders. */
export const DEFAULT_REUSE_THRESHOLD = 0.9;

/** Hash the exact question; case and whitespace may be meaningful inside record keys.
 * @param {string} question */
export async function questionFingerprint(question) {
  const bytes = new TextEncoder().encode(question);
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Compose author and runner with one fresh fallback and append-only failure evidence.
 * `check` is required when reuse is enabled, including the first successful stored run.
 * `accept` proves suitability before a paraphrase executes; an identical fingerprint
 * under the same host environment identity needs no separate suitability hook.
 * @param {{ environment: any, client?: any, compileQuery?: any, createStructuredOutput?: any,
 *   querySchema?: any, maxRepairs?: number, system?: string, recursive?: boolean,
 *   analyzeQuery?: any, annotateTypes?: any, selectModel?: any, limits?: any, onRoute?: any,
 *   depth?: number, account?: any, maxSubcalls?: number, maxConcurrentSubcalls?: number,
 *   reuse?: { environmentId: string, schemaVersion: string, threshold?: number,
 *   tools?: string[], embedder?: any, check: (context: any) => any,
 *   accept?: (context: any) => any }, author?: any, runner?: any }} options */
export function createProgramSession(options) {
  const author = options.author ?? createProgramAuthor(options);
  const runner = options.runner ?? createProgramRunner(options);
  const policy = options.reuse;
  if (policy !== undefined && (typeof policy.check !== 'function'
    || !policy.environmentId || !policy.schemaVersion))
    throw new TypeError('program reuse needs environmentId, schemaVersion and an outcome check');
  const threshold = policy?.threshold ?? DEFAULT_REUSE_THRESHOLD;
  if (!Number.isFinite(threshold) || threshold < -1 || threshold > 1)
    throw new TypeError('reuse threshold must be finite and between -1 and 1');
  const ledger = options.environment.ledger;

  return {
    async run(question, hooks = {}) {
      const events = [];
      const fingerprint = policy ? await questionFingerprint(question) : null;
      const tools = [...(policy?.tools ?? [])].sort();
      let candidate = null;
      let attempts = 0;
      const failed = async (skill, reason) => {
        events.push({ kind: 'rejected', skill: skill.id, reason });
        const evidence = await ledger.addMemory({ text: `Program reuse failed: ${reason}`,
          evidence: `skill:${skill.id}; question:${fingerprint}`, tags: ['program-reuse-failure'] });
        if (evidence.error) events.push({ kind: 'storage-error', operation: 'failure-evidence' });
      };
      if (policy && !hooks.signal?.aborted) {
        const recalled = await ledger.recallSkills({ near: question, limit: 5, minScore: threshold });
        events.push({ kind: 'retrieval', error: recalled.error ?? null });
        for (const [index, skill] of (recalled.skills ?? []).entries()) {
          const stored = skill.program;
          if (!stored) continue;
          const reason = stored.version !== 1 || stored.schemaVersion !== policy.schemaVersion ? 'schema-drift'
            : stored.environmentId !== policy.environmentId ? 'environment-drift'
              : JSON.stringify([...skill.tools].sort()) !== JSON.stringify(tools) ? 'tool-drift'
                : stored.checked !== true ? 'missing-success' : null;
          if (reason) { await failed(skill, reason); continue; }
          // A returned metadata record is mutable in some storage adapters. Validate
          // and compile it again rather than trusting a past compiler or cached closure.
          const names = (await ledger.listSlots()).map((slot) => slot.name);
          const gate = programGate({ compileQuery: options.compileQuery, known: names,
            recursive: options.recursive, analyzeQuery: options.analyzeQuery, annotateTypes: options.annotateTypes })(stored.document);
          if (gate !== true) { await failed(skill, 'compile-gate'); continue; }
          let suitable = stored.fingerprint === fingerprint;
          if (!suitable && policy.accept) {
            try { suitable = await policy.accept({ question, skill, score: recalled.scores[index] }) === true; }
            catch { suitable = false; }
          }
          if (!suitable) { await failed(skill, 'unsuitable'); continue; }
          candidate = skill;
          break;
        }
      }
      if (candidate) {
        const result = await runner.run(candidate.program.document, hooks);
        let accepted = false;
        if (result.ok) {
          try { accepted = checkOutcome(await policy.check({ question, result, reused: true })).valid; }
          catch { /* A checker exception is a failed reuse, never implicit success. */ }
        }
        if (accepted) {
          events.push({ kind: 'reused', skill: candidate.id });
          return { ...result, program: candidate.program.document, reuse: { reused: true, authorCalls: 0, fallback: false, events } };
        }
        await failed(candidate, result.ok ? 'wrong-outcome' : 'execution-failed');
      }
      if (hooks.signal?.aborted) return { ok: false, stopped: 'aborted', reuse: { reused: false, authorCalls: 0, events } };
      const authored = await author.author(question, hooks);
      attempts += authored.attempts ?? 1;
      const reuse = { reused: false, authorCalls: attempts, fallback: candidate !== null || events.some((event) => event.kind === 'rejected'), events };
      if (authored.value === undefined) return { ok: false, errors: authored.errors, reuse };
      const result = await runner.run(authored.value, hooks);
      if (!policy || !result.ok) return { ...result, program: authored.value, reuse };
      let checked = false;
      try { checked = checkOutcome(await policy.check({ question, result, reused: false })).valid; }
      catch { /* A failed fresh check ends this request; fallback never loops. */ }
      if (!checked) return { ...result, ok: false, error: 'fresh program failed outcome check', reuse };
      let pair = {};
      if (policy.embedder) {
        try {
          const [vector] = await policy.embedder.embed([question], { signal: hooks.signal });
          pair = { embedding: Array.from(vector), embeddedBy: { model: policy.embedder.model, dims: policy.embedder.dims } };
        }
        catch { events.push({ kind: 'embedding-failed' }); }
      }
      const saved = await ledger.addSkill({ name: 'Verified program', when: question,
        instructions: 'Run the verified program after checking its requirements.', tools, ...pair,
        program: { version: 1, question, fingerprint, environmentId: policy.environmentId,
          schemaVersion: policy.schemaVersion, document: authored.value,
          evidence: `outcome-check:${fingerprint}`, checked: true } });
      events.push(saved.error ? { kind: 'storage-error', operation: 'successful-program' } : { kind: 'stored', skill: saved.id });
      return { ...result, program: authored.value, reuse };
    },
  };
}
