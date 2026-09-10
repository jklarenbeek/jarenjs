//@ts-check
/** Differential evidence must count absent answers as well as changed returned answers. */
export function compareLexicalAnswers(text, reference, native, referenceReload, nativeReload) {
  const refIds = new Set(reference.map(hit => hit.id)), ids = new Set(native.map(hit => hit.id));
  const order = (a, b) => Math.abs(a.length - b.length) + a.filter((hit, i) => hit.id !== b[i]?.id).length;
  const scores = (a, b) => a.filter((hit, i) => !Number.isFinite(hit.score) || !Number.isFinite(b[i]?.score)
    || Math.abs(hit.score - b[i].score) > 1e-10).length;
  return { query: text, missingOrExtra: [...refIds].filter(id => !ids.has(id)).length + [...ids].filter(id => !refIds.has(id)).length,
    order: order(native, reference), score: scores(native, reference),
    referenceReloadTies: order(referenceReload, reference),
    nativeReload: order(nativeReload, native) + scores(nativeReload, native) };
}
