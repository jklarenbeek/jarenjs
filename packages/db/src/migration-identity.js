//@ts-check
/** Exact model endpoints, independent of migration execution and history. */
import { canonicalizeJson } from '@jarenjs/json/canonical';
import { withoutModelRenameHints } from '@jarenjs/core/model';
import { hashContent } from '@jarenjs/core/string';
import { DbCompileError } from './errors.js';

/** Canonical shape text; planning hints do not describe the resulting model.
 * @param {any} model @returns {string} */
export function modelIdentity(model) {
  return canonicalizeJson(withoutModelRenameHints(model));
}

/** The exact endpoints carried by a newly authored migration.
 * @param {any} from @param {any} to
 * @returns {{ version: 1, from: string, to: string }} */
export function migrationIdentity(from, to) {
  return { version: 1, from: modelIdentity(from), to: modelIdentity(to) };
}

/** Validate the versioned endpoint identity without granting history authority.
 * @param {any} migration */
export function checkMigrationIdentity(migration) {
  const invalid = (reason, path = '/identity', cause = undefined) =>
    new DbCompileError('JD0023', `migration '${migration.id}' ${reason}`, path, cause);
  if (migration.$migration === '0.1') {
    if (Object.hasOwn(migration, 'identity'))
      throw invalid('is a legacy 0.1 document and cannot carry an exact identity');
    return;
  }
  try {
    const member = Object.getOwnPropertyDescriptor(migration, 'identity');
    const identity = member && Object.hasOwn(member, 'value') ? member.value : undefined;
    if (!member?.enumerable || identity === null || typeof identity !== 'object' || Array.isArray(identity))
      throw invalid('requires identity { version: 1, from, to }');
    const fields = Object.getOwnPropertyDescriptors(identity);
    if (Reflect.ownKeys(fields).length !== 3
      || ['version', 'from', 'to'].some((key) => !Object.hasOwn(fields, key)
        || !fields[key].enumerable || !Object.hasOwn(fields[key], 'value'))
      || fields.version.value !== 1 || typeof fields.from.value !== 'string' || typeof fields.to.value !== 'string')
      throw invalid('requires only identity version 1 and canonical from/to model texts');
    // Canonicalization refuses non-JSON prototypes as well as values; descriptors
    // above keep inherited or effectful members out of this identity boundary.
    canonicalizeJson(identity);
    for (const side of ['from', 'to']) {
      const text = fields[side].value;
      let model;
      try { model = JSON.parse(text); }
      catch (cause) { throw invalid(`identity.${side} must be canonical $model 0.1 JSON text`, `/identity/${side}`, cause); }
      if (model === null || typeof model !== 'object' || Array.isArray(model)
        || !Object.hasOwn(model, '$model') || model.$model !== '0.1' || modelIdentity(model) !== text)
        throw invalid(`identity.${side} must be canonical $model 0.1 text without rename hints`, `/identity/${side}`);
      if (hashContent(text) !== migration[side])
        throw invalid(`${side} fingerprint does not match identity.${side}`, `/${side}`);
    }
  }
  catch (error) {
    if (error instanceof DbCompileError) throw error;
    throw invalid('requires a plain JSON endpoint identity', '/identity', error);
  }
}
