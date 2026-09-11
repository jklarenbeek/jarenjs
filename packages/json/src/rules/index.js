//@ts-check
/** Immutable reviewed plans; execution authority remains in the host transaction. */
import { canonicalizeJson, canonicalSha256 } from '../canonical.js';
import { compileJSONPointer, JSONPOINTER_NOTHING } from '../pointer.js';
import { compileFormulaBatch } from '../formula/batch.js';
import { FormulaError, snapshot, credit } from '../formula/shared.js';

/**
 * Compile rule targets over the shared formula batch evaluator.
 * groupKey is an application-declared deduplication policy; group/sibling values
 * are explicit context. Writable fields are an explicit allowlist.
 * @param {any} definition
 * @param {import('../formula/index.js').FormulaOptions & {writableFields:string[],groupKey?:(row:any,context:any)=>any,maxRows?:number,maxCells?:number,maxErrors?:number}} options
 */
export function compileRulePlan(definition, options) {
  const doc = snapshot(definition);
  if (!doc || doc.$rules !== '1' || typeof doc.id !== 'string' || !doc.id || typeof doc.revision !== 'string'
    || !doc.revision || !Array.isArray(doc.targets) || !Array.isArray(options?.writableFields))
    throw new FormulaError('JQ2015', 'rule identity, targets and writable fields required', doc?.id ?? '', '');
  const allowed = new Set(options.writableFields);
  const pointers = new Map();
  for (const [i, target] of doc.targets.entries()) if (target.enabled !== false) {
    if (typeof target.field !== 'string' || !target.field.startsWith('/') || !allowed.has(target.field))
      throw new FormulaError('JQ2015', 'target field is not writable', doc.id, `/targets/${i}/field`);
    pointers.set(target.id, compileJSONPointer(target.field));
  }
  const batch = compileFormulaBatch(doc.targets, options);
  const maxRows = credit(options.maxRows, 10000, 'maxRows');
  const maxErrors = credit(options.maxErrors, 100, 'maxErrors');
  return Object.freeze({ doc,
    /** Read-only preview. A current snapshot revision is mandatory, never inferred from loaded rows. */
    async preview({ rows, datasetRevision, context = {} }) {
      if (!Array.isArray(rows) || rows.length > maxRows || typeof datasetRevision !== 'string' || !datasetRevision)
        throw new FormulaError('JQ2015', 'bounded rows and dataset revision required', doc.id, '');
      const data = snapshot(rows), scope = snapshot(context);
      const groups = new Set(), selected = [], ids = new Set();
      let deduplicated = 0;
      for (const row of data) {
        const key = canonicalizeJson(row.id);
        if (ids.has(key)) throw new FormulaError('JQ2015', 'duplicate entity identity', doc.id, '');
        ids.add(key);
        if (options.groupKey) {
          const group = canonicalizeJson(options.groupKey(row, scope));
          if (groups.has(group)) { deduplicated++; continue; }
          groups.add(group);
        }
        selected.push(row);
      }
      const result = batch.evaluate(selected, { context: scope });
      const byId = new Map(selected.map((row) => [canonicalizeJson(row.id), row]));
      const candidates = new Map(), conflicts = new Set();
      const errors = [...result.errors];
      const counts = { ...result.counts, inputRows: data.length, candidates: 0, changes: 0, noops: 0, conflicts: 0, deduplicated };
      // Evaluation cost is observable but not a content identity: cache warmth does not change a plan.
      delete counts.evaluated; delete counts.cached;
      for (const rowResult of result.results) {
        const row = byId.get(canonicalizeJson(rowResult.id));
        for (const target of doc.targets) {
          const outcome = rowResult.outcomes[target.id];
          if (!Object.hasOwn(outcome, 'value')) continue;
          counts.candidates++;
          const beforeValue = pointers.get(target.id)(row);
          const before = beforeValue === JSONPOINTER_NOTHING ? { present: false } : { present: true, value: beforeValue };
          if (before.present && canonicalizeJson(before.value) === canonicalizeJson(outcome.value)) counts.noops++;
          const key = canonicalizeJson([row.id, target.field]);
          if (conflicts.has(key)) continue;
          const previous = candidates.get(key);
          if (previous) {
            if (canonicalizeJson(previous.proposed) === canonicalizeJson(outcome.value)) { counts.deduplicated++; previous.targetIds.push(target.id); }
            else {
              candidates.delete(key); conflicts.add(key); counts.conflicts++;
              if (errors.length < maxErrors) errors.push({ rowId: row.id, targetId: target.id, code: 'JQ2015', message: 'conflicting target values', docPath: '/targets' });
            }
          }
          else candidates.set(key, { id: await canonicalSha256([doc.id, doc.revision, datasetRevision, row.id, target.field]),
            entityId: row.id, field: target.field, before, proposed: outcome.value, targetIds: [target.id],
            ...(outcome.kind === 'explanation' ? { explanation: outcome.text } : {}) });
        }
      }
      const changes = [...candidates.values()].filter((change) => !change.before.present || canonicalizeJson(change.before.value) !== canonicalizeJson(change.proposed)); counts.changes = changes.length;
      const body = snapshot({ version: 1, rule: { id: doc.id, revision: doc.revision, hash: await canonicalSha256(doc) },
        datasetRevision, targets: doc.targets.filter((target) => target.enabled !== false).map((target) => target.id),
        changes, counts, errors, omittedErrors: result.omittedErrors + Math.max(0, counts.conflicts - (errors.length - result.errors.length)) });
      return snapshot({ ...body, id: await canonicalSha256(body) });
    },
  });
}

/**
 * Recheck a selection against a freshly computed authoritative plan. Call INSIDE
 * the validated command's transaction, after current authorization and reads.
 * Hashes identify content; they are not signatures or permission to write.
 */
export async function selectRuleChanges(plan, selection, currentPlan) {
  plan = snapshot(plan); currentPlan = snapshot(currentPlan); selection = snapshot(selection);
  const { id, ...body } = plan;
  const { id: currentId, ...currentBody } = currentPlan;
  if (id !== await canonicalSha256(body) || currentId !== await canonicalSha256(currentBody) || id !== currentId)
    throw new FormulaError('JQ2015', 'stale or modified preview', plan.rule?.id ?? '', '');
  if (!Array.isArray(selection) || new Set(selection).size !== selection.length)
    throw new FormulaError('JQ2015', 'selection must contain unique change IDs', plan.rule.id, '/selection');
  const changes = new Map(currentPlan.changes.map((change) => [change.id, change]));
  return snapshot(selection.map((key) => {
    if (!changes.has(key)) throw new FormulaError('JQ2015', 'unknown selected change', plan.rule.id, '/selection');
    return changes.get(key);
  }));
}
