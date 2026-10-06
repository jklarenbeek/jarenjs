//@ts-check
/** Exact endpoint headers for hand-authored migration execution fixtures. */
import { withoutModelRenameHints } from '@jarenjs/core/model';
import { canonicalizeJson } from '@jarenjs/json/canonical';

/** @param {unknown} from @param {unknown} [to] */
export function migrationIdentity(from, to = from) {
  return { version: 1, from: canonicalizeJson(withoutModelRenameHints(from)),
    to: canonicalizeJson(withoutModelRenameHints(to)) };
}
