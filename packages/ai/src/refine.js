//@ts-check
/**
 * Refinement: how an agent's durable state improves without anyone
 * rewriting it.
 *
 * After a run, the model is asked what it learned. The answer is not
 * prose and it is not a new system prompt — it is an RFC 6902 JSON Patch
 * over the ledger's supplemental state, generated through
 * `createStructuredOutput` and put through four stages before any of it
 * lands:
 *
 *  1. **shape** — the patch validates against the constrained schema
 *     (`schemas/patch.js`): three verbs, a path pattern that matches
 *     only the supplemental subtree, a cap on the number of operations.
 *  2. **semantics** — the patch is applied to a COPY of the state
 *     through the injected patch engine. An operation that cannot apply
 *     is a compile-style error with a pointer into the patch document,
 *     which is exactly the error class this package's field notes say
 *     small models repair well.
 *  3. **legality** — every record the patched document would store is
 *     validated against the LEDGER's own schemas. A memory without
 *     evidence dies here, before anything is written, so the model can
 *     be told why and try again.
 *  4. **commit** — a snapshot is taken, then the writes go through the
 *     ledger's own API. Any rejection rolls the whole thing back: there
 *     is no half-applied refinement.
 *
 * Why a patch rather than a rewrite: a rewrite is unreviewable and
 * unbounded, and a model asked to restate its memories will drift them.
 * A patch is small, auditable, and undone by the snapshot from the
 * ledger. Two things follow from that and are worth saying out loud:
 *
 *  - **The base system prompt is not a patch target.** Not "should not
 *    be" — it is not IN the document a patch is applied to, and no path
 *    that could reach it matches the schema's pattern. There is no
 *    operation a model can write that edits its own instructions.
 *  - **Every stored memory carries evidence**, because the ledger
 *    rejects one that does not. That is the mechanism by which
 *    "evidence-backed updates" is enforced rather than hoped for.
 *
 * The patch engine is INJECTED (`applyPatch`), like every other heavy
 * thing this package touches: `@jarenjs/json` ships an RFC 6902 engine
 * and this package must not import it. With the seam empty, refinement
 * declines with a stated reason and the rest of the ledger is unaffected
 * — the same degrade-to-nothing posture as the retrieval seam.
 */

import { JarenValidator } from '@jarenjs/validate';

import { checkOutcome } from './check.js';
import { createStructuredOutput } from './structured.js';
import { REFINEMENT_PATCH_SCHEMA, refinementPatchSchema } from './schemas/patch.js';
import { excerpt, truncate } from '@jarenjs/core/chunk';

/**
 * The id stood in while a proposal is validated. A proposal never
 * carries an id — identity is the ledger's to mint, or a model could
 * overwrite a record it never read — so the record validated at stage 3
 * is the record that will be stored with the id filled in at stage 4.
 * The placeholder is the one member that differs, and it is a legal id
 * (non-empty string), so it exercises the same schema the real one will.
 */
const PENDING_ID = '(minted on commit)';

/**
 * The members a proposal may leave out and the ledger fills in. They
 * mirror `addMemory`/`addSkill`, and they are here because stage 3 has
 * to validate the record that WILL be stored rather than the shorter one
 * that was proposed — a memory with no `tags` is storable, and a gate
 * that rejected it would be rejecting the ledger's own default.
 *
 * The two copies cannot drift silently: the ledger validates again on
 * the way in, so a divergence surfaces as a rolled-back commit naming
 * the member, not as a record that should never have been written.
 */
const RECORD_DEFAULTS = { memory: { tags: [] }, skill: { tools: [] } };

/** How much of a run's trajectory travels in the proposal prompt. */
const TRAJECTORY_CHARS = 4000;

/** The per-line cap inside that block. */
const LINE_CHARS = 200;

/** @param {any} value */
const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Structural equality over JSON values, by canonical-enough comparison. */
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * One error record, in the shape the repair prompt carries: a code, a
 * pointer and a reason. `docPath` points into the PATCH document
 * wherever the failure can be attributed to one operation, because
 * "which operation was wrong" is the whole difference between a repair
 * round that converges and one that flails.
 *
 * The codes this module raises, all of them records rather than throws
 * (`errors.js` reserves `AiError` for transport and misuse; a rejected
 * proposal is neither — it is something a model reads and fixes):
 *
 *   AI0100 — a supplemental record is not an object
 *   AI0101 — a proposal chose its own id
 *   AI0102 — the record is not storable (the ledger's own validation
 *            keyword travels in place of this wherever it has one)
 *   AI0103 — progress proposed with no active goal
 *   AI0104 — the goal itself was changed, not just its progress
 *   AI0105 — progress is not append-only
 *   AI0106 — the patched state is not an object
 *
 * A failure inside the injected patch engine keeps THAT engine's code
 * (`JP0004`, `JP2001`, …) rather than being renumbered here: the pointer
 * and the code are what the model repairs from, and translating them
 * would lose the only precise thing about them.
 * @param {string} code
 * @param {string} message
 * @param {string} docPath
 */
const problem = (code, message, docPath) => ({ code, docPath, message });

/**
 * The coded, pointered form of whatever the injected patch engine threw.
 * `@jarenjs/json` raises `JsonPatchCompileError` / `JsonPatchRuntimeError`
 * with a `code`, a `docPath` into the patch and (at runtime) a
 * `dataPath` into the document; a different engine may raise anything.
 * Both end up as one record the model can act on.
 * @param {any} error
 */
function patchFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : 'PATCH';
  const docPath = typeof error?.docPath === 'string' ? error.docPath : '';
  const reason = error?.reason ?? error?.message ?? String(error);
  const at = typeof error?.dataPath === 'string' && error.dataPath !== ''
    ? ` (target '${error.dataPath}' in the supplemental state)`
    : '';
  return problem(code, `the patch does not apply: ${reason}${at}`, docPath);
}

/**
 * The run, as the few hundred characters worth putting in front of the
 * model. Tool steps are preferred over wire messages: the steps ARE the
 * evidence a memory would cite, and a transcript's assistant turns are
 * mostly the model reading its own prose back.
 * @param {any} trajectory - a `send` result, its `steps`, or wire messages
 * @param {number} max
 * @returns {string}
 */
export function describeTrajectory(trajectory, max = TRAJECTORY_CHARS) {
  const steps = Array.isArray(trajectory?.steps) ? trajectory.steps : null;
  const messages = Array.isArray(trajectory)
    ? trajectory
    : (Array.isArray(trajectory?.messages) ? trajectory.messages : null);

  /** @type {string[]} */
  const lines = [];
  if (steps !== null && steps.length > 0) {
    for (const step of steps) {
      lines.push(`- ${step.name}(${excerpt(step.arguments, 80)}) → `
        + `${excerpt(JSON.stringify(step.result ?? null), LINE_CHARS)}`);
    }
  }
  if (messages !== null) {
    for (const message of messages) {
      if (message?.role === 'system') continue;
      if (steps !== null && steps.length > 0 && message?.role === 'tool') continue;
      const text = excerpt(message?.content, LINE_CHARS);
      if (text !== '') lines.push(`- ${message.role}: ${text}`);
    }
  }
  return truncate(lines.join('\n'), max);
}

/**
 * Create a refiner over a ledger.
 *
 * @param {{ client: any, ledger: any,
 *   applyPatch?: ((document: any, patch: any[]) => any) | null,
 *   maxOps?: number, maxRepairs?: number, validator?: any,
 *   now?: () => string, trajectoryChars?: number,
 *   instructions?: string }} options
 *   - `applyPatch` is the RFC 6902 seam: `(document, patch) => document`,
 *     normally `(doc, patch) => applyJSONPatch(doc, patch)` from
 *     `@jarenjs/json`. Absent, `refine`/`commit` decline with a stated
 *     reason rather than half-working.
 *   - `maxOps` caps the operations one refinement may propose (default
 *     6, from the schema).
 *   - `maxRepairs` is how many failed rounds go back to the model with
 *     the errors before it declines (default 1).
 *   - `instructions` replaces the proposal prompt's task description
 *     (the state, the rules and the trajectory are always appended).
 *   - `now` returns an RFC 3339 timestamp, injected for deterministic
 *     tests exactly as the ledger injects its clock.
 * @returns {{ state: () => Promise<any>,
 *   commit: (patch: any[]) => Promise<any>,
 *   refine: (trajectory: any, hooks?: { signal?: AbortSignal }) => Promise<any>,
 *   patchSchema: any }}
 */
export function createRefiner(options) {
  const { client, ledger } = options;
  if (ledger === null || typeof ledger?.snapshot !== 'function') {
    throw new TypeError('createRefiner needs a ledger (createLedger())');
  }
  const applyPatch = typeof options.applyPatch === 'function' ? options.applyPatch : null;
  const now = options.now ?? (() => new Date().toISOString());
  const maxRepairs = options.maxRepairs ?? 1;
  const trajectoryChars = options.trajectoryChars ?? TRAJECTORY_CHARS;
  const patchSchema = options.maxOps === undefined
    ? REFINEMENT_PATCH_SCHEMA
    : refinementPatchSchema({ maxOps: options.maxOps });
  // the shape check, compiled once — the same schema the generator
  // constrains decoding with, so a hand-written patch handed to
  // `commit` is held to exactly what a generated one is held to
  const compiled = options.validator
    ?? new JarenValidator({ skipErrors: false, collectErrors: true, unknownFormats: 'ignore' })
      .compile(patchSchema);
  const checkShape = (patch) => checkOutcome(compiled(patch));

  const noEngine = {
    error: 'refinement needs the applyPatch seam — inject '
      + '(doc, patch) => applyJSONPatch(doc, patch) from @jarenjs/json',
  };

  /**
   * The supplemental state, as the document a patch is applied to. It is
   * the ledger's own records verbatim — nothing here is a projection
   * that would have to be mapped back — and it contains the goal, the
   * memories and the skills and NOTHING else. The base system prompt is
   * absent by construction, which is the first half of why it cannot be
   * patched (the path pattern is the second).
   */
  async function state() {
    return {
      goal: await ledger.getGoal(),
      memories: await ledger.listMemories(),
      skills: await ledger.listSkills(),
    };
  }

  /**
   * Stage 3, for one kind: the writes a patched document implies, with
   * every record completed and validated. Identity is the `id`, which a
   * proposal never carries — so an entry without one is a new record and
   * a stored record missing from the next document was removed. A
   * `replace` therefore reads as "remove that one, store this one",
   * which is what revising a memory actually is: a different claim, with
   * different evidence, made at a different time.
   * @param {'memory'|'skill'} kind
   * @param {any[]} previous
   * @param {any[]} next
   * @param {string} field - the document member, for the error pointer
   */
  function planKind(kind, previous, next, field) {
    /** @type {any[]} */
    const errors = [];
    /** @type {any[]} */
    const add = [];
    const known = new Map(previous.map((record) => [record.id, record]));
    const kept = new Set();

    next.forEach((entry, index) => {
      const at = `/${field}/${index}`;
      if (!isRecord(entry)) {
        errors.push(problem('AI0100', `a ${kind} must be an object`, at));
        return;
      }
      if (typeof entry.id === 'string' && known.has(entry.id)) {
        kept.add(entry.id);
        // unchanged records are not rewritten: a refinement that touched
        // nothing must leave the timestamps it did not touch alone
        if (sameJson(entry, known.get(entry.id))) return;
      }
      else if (entry.id !== undefined) {
        errors.push(problem('AI0101',
          `a ${kind} may not choose its own id ('${entry.id}') — omit it and the ledger mints one`,
          at));
        return;
      }
      const record = { ...RECORD_DEFAULTS[kind], ...entry, at: entry.at ?? now() };
      const rejected = ledger.validate(kind, { ...record, id: record.id ?? PENDING_ID });
      if (rejected !== null) {
        for (const error of rejected.errors ?? []) {
          errors.push(problem(error.keyword === '' ? 'AI0102' : error.keyword,
            `the ${kind} is not storable: ${error.message}`,
            `${at}${error.instancePath ?? ''}`));
        }
        if ((rejected.errors ?? []).length === 0)
          errors.push(problem('AI0102', `the ${kind} is not storable`, at));
        return;
      }
      add.push(record);
    });

    const remove = previous.filter((record) => !kept.has(record.id)).map((record) => record.id);
    return { add, remove, errors };
  }

  /**
   * The progress the patched document appends. Append-only is checked
   * rather than assumed: the path pattern cannot express a rewrite, and
   * this is the assertion that says so even if a caller hands `commit` a
   * patch that never met the pattern.
   * @param {any} previous - the stored goal, or null
   * @param {any} next - the patched goal
   */
  function planProgress(previous, next) {
    /** @type {any[]} */
    const errors = [];
    const before = previous?.progress ?? [];
    const after = next?.progress ?? [];
    if (previous === null && (next !== null || after.length > 0)) {
      errors.push(problem('AI0103',
        'there is no active goal to record progress against — call setGoal first', '/goal'));
      return { append: [], errors };
    }
    if (next !== null && next !== undefined && !sameJson(
      { ...next, progress: before }, { ...previous, progress: before })) {
      errors.push(problem('AI0104',
        'a refinement may not change the goal itself — only append to its progress', '/goal'));
      return { append: [], errors };
    }
    if (after.length < before.length
      || !sameJson(after.slice(0, before.length), before)) {
      errors.push(problem('AI0105',
        'progress is append-only — earlier entries may not be edited or removed',
        '/goal/progress'));
      return { append: [], errors };
    }
    const append = after.slice(before.length).map((entry) => (isRecord(entry)
      ? { ...entry, at: entry.at ?? now() }
      : entry));
    if (append.length > 0) {
      // validated as a WHOLE goal, because that is the record the ledger
      // stores: an entry legal on its own but illegal in place would
      // otherwise pass here and be rejected at commit
      const rejected = ledger.validate('goal', { ...previous, progress: [...before, ...append] });
      if (rejected !== null) {
        for (const error of rejected.errors ?? []) {
          errors.push(problem(error.keyword === '' ? 'AI0102' : error.keyword,
            `the progress entry is not storable: ${error.message}`,
            `/goal${error.instancePath ?? ''}`));
        }
      }
    }
    return { append, errors };
  }

  /**
   * Stages 1 to 3 over a copy — everything that can be known without
   * writing anything. This is what the generator's `gate` runs, so a
   * proposal that cannot land comes back to the model with pointers
   * instead of landing half-way and being rolled back.
   * @param {any} document - the state as it stands
   * @param {any[]} patch
   * @returns {{ valid: boolean, errors: any[], plan?: any, next?: any }}
   */
  function dryRun(document, patch) {
    const shape = checkShape(patch);
    if (!shape.valid) return { valid: false, errors: shape.errors };

    /** @type {any} */
    let next;
    try {
      // a COPY, always: the seam is injected and this module does not get
      // to assume it is copy-on-write, however much the one we ship is
      next = applyPatch(JSON.parse(JSON.stringify(document)), patch);
    }
    catch (error) {
      return { valid: false, errors: [patchFailure(error)] };
    }
    if (!isRecord(next)) {
      return { valid: false,
        errors: [problem('AI0106', 'the patched state is not an object', '')] };
    }

    const memories = planKind('memory', document.memories, next.memories ?? [], 'memories');
    const skills = planKind('skill', document.skills, next.skills ?? [], 'skills');
    const progress = planProgress(document.goal, next.goal ?? null);
    const errors = [...memories.errors, ...skills.errors, ...progress.errors];
    if (errors.length > 0) return { valid: false, errors };
    return { valid: true, errors: [], next, plan: { memories, skills, progress } };
  }

  /** Whether a plan would write anything at all. */
  const empty = (plan) => plan.memories.add.length === 0 && plan.memories.remove.length === 0
    && plan.skills.add.length === 0 && plan.skills.remove.length === 0
    && plan.progress.append.length === 0;

  /**
   * Stage 4: snapshot, then write through the ledger's own API — never
   * into storage, so every record passes the same validation a
   * hand-written one does. A rejection anywhere rolls the whole
   * refinement back, so the state after a failed commit is the state
   * before it, byte for byte.
   * @param {any} document
   * @param {any[]} patch
   */
  async function commitAgainst(document, patch) {
    const dry = dryRun(document, patch);
    if (!dry.valid) {
      return { error: 'the refinement was rejected', errors: dry.errors, patchSchema };
    }
    const plan = dry.plan;
    if (empty(plan)) {
      return { ok: true, patch, snapshot: null, memories: [], skills: [], progress: [] };
    }

    const token = await ledger.snapshot();
    /** @type {{ memories: any[], skills: any[], progress: any[] }} */
    const written = { memories: [], skills: [], progress: [] };
    /**
     * A ledger rejection, turned into the rolled-back answer. Reached
     * only when stage 3 said a record was storable and the ledger
     * disagreed — which would be a defect in this module rather than in
     * the patch, and is therefore reported rather than swallowed.
     * @param {any} outcome
     * @param {string} what
     */
    const failure = (outcome, what) => (outcome?.error === undefined
      ? null
      : { error: `the refinement was rolled back: ${what} — ${outcome.error}`,
        errors: outcome.errors ?? [], patchSchema, snapshot: token });

    // stored BEFORE the removals, which is not cosmetic: the ledger
    // mints an id from the count of records that exist, so removing
    // first would let a replacement be minted the id of the record it
    // replaced. Two different claims sharing one address is exactly what
    // an auditable ledger may not do.
    for (const record of plan.memories.add) {
      const stop = failure(await ledger.addMemory(record), 'a memory could not be stored');
      if (stop !== null) {
        await ledger.rollback(token);
        return stop;
      }
      written.memories.push(record);
    }
    for (const record of plan.skills.add) {
      const stop = failure(await ledger.addSkill(record), 'a skill could not be stored');
      if (stop !== null) {
        await ledger.rollback(token);
        return stop;
      }
      written.skills.push(record);
    }
    for (const id of plan.memories.remove) await ledger.deleteMemory(id);
    for (const id of plan.skills.remove) await ledger.deleteSkill(id);
    for (const entry of plan.progress.append) {
      const stop = failure(await ledger.recordProgress(entry),
        'a progress entry could not be recorded');
      if (stop !== null) {
        await ledger.rollback(token);
        return stop;
      }
      written.progress.push(entry);
    }

    return {
      ok: true,
      patch,
      // the token is returned, not kept: rolling a refinement back is the
      // host's call to make, and a snapshot nobody was told about is a
      // reversal nobody can perform
      snapshot: token,
      removed: { memories: plan.memories.remove, skills: plan.skills.remove },
      ...written,
    };
  }

  /**
   * Apply a patch that already exists — the same four stages a generated
   * one goes through, exposed because a host (or a test) writing the
   * patch itself must not get a weaker gate than a model does.
   * @param {any[]} patch
   */
  async function commit(patch) {
    if (applyPatch === null) return { ...noEngine, patchSchema };
    return commitAgainst(await state(), patch);
  }

  /**
   * The proposal prompt. The state is shown in full and the rules are
   * stated in the imperative, because the field notes are clear that
   * breadth and posture belong in the prompt while correctness belongs
   * in the gate.
   * @param {any} document
   * @param {any} trajectory
   */
  function prompt(document, trajectory) {
    const task = options.instructions ?? [
      'You have just finished a run. Propose what should be remembered from it, as an RFC 6902',
      'JSON Patch over your supplemental state.',
      '',
      'Rules:',
      '- Every memory and every progress entry MUST carry `evidence`: what in the run below',
      '  establishes it. Quote the tool result or name the fact. Never write a memory you cannot',
      '  cite — an empty patch is a better answer than an invented one.',
      '- Store what will still be true and still be useful next time. Not what happened; what it',
      '  means.',
      '- Do not restate a memory that is already stored, and do not add a near-duplicate of one.',
      '- Append with /memories/-, /skills/- and /goal/progress/-. Replace or remove an existing',
      '  record by its index. Nothing else is addressable.',
      '',
      // the shape table and the worked example are not decoration. Every
      // trial on the qwen tier failed its FIRST attempt without them, and
      // always the same way: a progress entry written in the memory's
      // shape (`text` where the goal wants `note`). The schema cannot
      // rule that out — `value` is one union for three paths — so it is
      // the prompt's job, and this is the package's own field note
      // ("a few-shot example fixes shape") applied to its own harness.
      'Each path takes its own shape:',
      '  /memories/-       {"text": …, "evidence": …, "tags": [ … ]}',
      '  /skills/-         {"name": …, "when": …, "instructions": …, "tools": [ … ]}',
      '  /goal/progress/-  {"note": …, "evidence": …}          <- note, NOT text',
      '',
      'Example of a well-formed refinement:',
      '[{"op":"add","path":"/memories/-","value":{"text":"…","evidence":"…","tags":["…"]}},'
        + '{"op":"add","path":"/goal/progress/-","value":{"note":"…","evidence":"…"}}]',
    ].join('\n');
    return [
      task,
      '',
      'Your supplemental state right now:',
      JSON.stringify(document, null, 1),
      '',
      'The run:',
      describeTrajectory(trajectory, trajectoryChars),
    ].join('\n');
  }

  /**
   * Propose and apply a refinement for one run.
   *
   * The gate runs INSIDE generation (as `createStructuredOutput`'s
   * `gate`), so a patch that does not apply or would store an
   * unevidenced memory comes back to the model with its pointers for a
   * bounded repair. What survives generation is committed against the
   * same state the gate ran over.
   * @param {any} trajectory - a `send` result, its `steps`, or messages
   * @param {{ signal?: AbortSignal }} [hooks]
   */
  async function refine(trajectory, hooks = {}) {
    if (applyPatch === null) return { ...noEngine, patchSchema };
    // read ONCE: the gate has to be synchronous (a compiled check is),
    // and a gate that re-read the ledger between attempts would be
    // judging each attempt against a different state
    const document = await state();
    const generator = createStructuredOutput({
      client,
      schema: patchSchema,
      name: 'refinement',
      // a `remove` carries no `value`, so `value` is optional, and
      // OpenAI's strict mode requires every declared property to be
      // required. The local check is the authority either way.
      strict: false,
      gate: (patch) => dryRun(document, patch),
      maxRepairs,
    });
    const result = await generator.generate([{ role: 'user', content: prompt(document, trajectory) }],
      hooks);
    if (result.errors !== undefined) {
      return {
        error: 'the model did not produce an applicable refinement',
        errors: result.errors,
        attempts: result.attempts,
        raw: result.raw,
        patchSchema,
      };
    }
    return { ...await commitAgainst(document, result.value), attempts: result.attempts };
  }

  return { state, commit, refine, patchSchema };
}
