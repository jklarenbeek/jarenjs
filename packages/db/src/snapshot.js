//@ts-check
/** A revision-checked read inside the caller's existing transaction owner. */

/** A monotone enrolled revision (or an injected source token) surrounds every
 * read. READ COMMITTED may change between statements; never label that mixture
 * with either revision. SQLite's transaction snapshot naturally keeps its token.
 * @param {() => any} revision @param {(revision:any)=>any} read @returns {Promise<any>} */
export async function readRevisionSnapshot(revision, read) {
  const before = await revision();
  const value = await read(before);
  const after = await revision();
  return { value, revision: before, consistent: Object.is(before, after) };
}
