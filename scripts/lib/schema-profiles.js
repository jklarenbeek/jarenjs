//@ts-check
/**
 * Mechanically derive the LLM-profile twin of a canonical schema
 * artifact: the lowest-common-denominator relaxation for provider
 * structured-output subsets that do not enforce `patternProperties`,
 * `propertyNames` or asserted `format`s — and that support `anyOf` but
 * not `oneOf` (every `oneOf` becomes `anyOf`; the canonical grammar
 * discriminates its branches by the removed name constraints, so
 * exactly-one would fail on its own relaxation). Each removed
 * constraint is restated in the node's `description` (the model still
 * reads it), and the canonical schema remains the local-validation
 * authority. The transform is a pure RELAXATION: every canonical-valid
 * document is profile-valid; the reverse is deliberately not
 * guaranteed.
 * @param {object} schema - canonical draft 2020-12 artifact
 * @returns {object} mechanically derived LLM-profile twin
 */
export function deriveLlmProfile(schema) {
  function note(key, value) {
    if (key === 'format')
      return `(LLM profile: the '${value}' format assertion is relaxed here; the canonical schema enforces it)`;
    return '(LLM profile: a member-name constraint is relaxed here; the canonical schema enforces it)';
  }

  function walk(node) {
    if (Array.isArray(node))
      return node.map(walk);
    if (node === null || typeof node !== 'object')
      return node;
    const out = {};
    const notes = [];
    for (const key of Object.keys(node)) {
      if (key === 'patternProperties' || key === 'propertyNames' || key === 'format') {
        notes.push(note(key, node[key]));
        continue;
      }
      if (key === 'oneOf') {
        // exactly-one becomes at-least-one: the canonical grammar
        // discriminates its oneOf branches by the very name
        // constraints removed above, and strict provider subsets
        // (OpenAI's included) support anyOf but not oneOf
        if (Object.hasOwn(node, 'anyOf'))
          throw new TypeError('LLM-profile derivation: a node carries both oneOf and anyOf');
        out.anyOf = walk(node.oneOf);
        continue;
      }
      out[key] = walk(node[key]);
    }
    if (notes.length > 0) {
      out.description = out.description === undefined
        ? notes.join(' ')
        : `${out.description} ${notes.join(' ')}`;
    }
    return out;
  }

  const twin = walk(schema);
  twin.$id = schema.$id + '/llm-profile';
  twin.title = schema.title + ' (LLM profile)';
  twin.description = 'LLM-profile relaxation of the canonical grammar for provider '
    + 'structured-output subsets that do not enforce patternProperties, propertyNames '
    + 'or asserted formats. Every canonical-valid document validates here; the reverse '
    + 'is NOT guaranteed - always validate generated documents against the canonical '
    + 'schema locally before compiling. '
    + (schema.description ?? '');
  return twin;
}

/**
 * Mechanically derive the AUTHORING profile of a document grammar: the
 * same relaxation {@link deriveLlmProfile} performs, plus a narrowing —
 * one or more `$defs` are declared OPEN and everything reachable only
 * through them is dropped.
 *
 * The reason this exists is measured, not stylistic. An oversized
 * `response_format` degrades constrained decoding on small models to the
 * point of returning nothing; the JSLT grammar is ~19 kB because it
 * inlines the whole query expression language, and the LLM-profile twin
 * is no smaller (relaxation restates what it removes, so it GROWS).
 * Cutting at the body — the one `$ref` that pulls the expression grammar
 * in — turns the response format back into what it is good at (holding
 * the document's *shape*) and leaves meaning to the compiler, which was
 * always the authority for it. This is the same seam
 * `programSchema({ queryRef })` uses: a grammar is constrained when one
 * is injected and gated by the engine either way.
 *
 * The vocabulary the narrowing removes is not lost — it belongs in the
 * PROMPT, where {@link deriveOperatorNames} puts it, and where it costs
 * a decoder nothing.
 *
 * @param {object} schema - canonical draft 2020-12 artifact
 * @param {{ open: Record<string, string> }} options - `$defs` names to
 *   leave open, mapped to the description the open node carries. An
 *   open node has NO type constraint: any JSON value decodes there.
 * @returns {object} mechanically derived authoring twin
 */
export function deriveAuthoringProfile(schema, options) {
  const open = options?.open;
  if (open === null || typeof open !== 'object')
    throw new TypeError('deriveAuthoringProfile needs an { open } map of $defs names');
  const defs = schema.$defs ?? {};
  for (const name of Object.keys(open)) {
    if (!Object.hasOwn(defs, name))
      throw new TypeError(`deriveAuthoringProfile: no $defs.${name} to open`);
  }

  // Reachability from the root, following local $refs and stopping AT an
  // opened def — a def reachable only through the body disappears with it.
  const reached = new Set();
  const localRef = (value) => (typeof value === 'string' && value.startsWith('#/$defs/')
    ? value.slice('#/$defs/'.length)
    : null);
  function reach(node) {
    if (Array.isArray(node)) { for (const item of node) reach(item); return; }
    if (node === null || typeof node !== 'object') return;
    for (const key of Object.keys(node)) {
      const name = key === '$ref' ? localRef(node[key]) : null;
      if (name === null) { reach(node[key]); continue; }
      if (reached.has(name)) continue;
      reached.add(name);
      if (!Object.hasOwn(open, name)) reach(defs[name]);
    }
  }
  const root = { ...schema };
  delete root.$defs;
  reach(root);

  // Keep a type shared by every branch of an opened seam. In particular, opening
  // the query's object-expression branch must not turn the entire root anyOf into
  // an unconstrained schema. This is inferred from the source, never hand-copied.
  function commonType(node, seen = new Set()) {
    if (!node || typeof node !== 'object') return null;
    if (typeof node.type === 'string') return node.type;
    const name = localRef(node.$ref);
    if (name !== null) {
      if (seen.has(name)) return null;
      return commonType(defs[name], new Set([...seen, name]));
    }
    const branches = node.oneOf ?? node.anyOf;
    if (!Array.isArray(branches) || branches.length === 0) return null;
    const types = branches.map((branch) => commonType(branch, seen));
    return types[0] !== null && types.every((type) => type === types[0]) ? types[0] : null;
  }

  const twin = deriveLlmProfile({
    ...root,
    $defs: Object.fromEntries(Object.keys(defs)
      .filter((name) => reached.has(name))
      .map((name) => [name, Object.hasOwn(open, name)
        ? { ...(commonType(defs[name]) === null ? {} : { type: commonType(defs[name]) }), description: open[name] }
        : defs[name]])),
  });
  twin.$id = schema.$id + '/authoring';
  twin.title = schema.title + ' (authoring profile)';
  twin.description = 'Authoring profile of the canonical grammar: the document SHAPE only, '
    + `with ${Object.keys(open).join(', ')} left open. Constrains decoding on small models, `
    + 'where the full grammar does not decode at all. It is deliberately WEAKER than the '
    + 'canonical schema - a document valid here may be nonsense - so the engine compiler is '
    + 'the gate that makes it safe, and generated documents must be compiled before use.';
  return twin;
}

/**
 * Where the JSLT grammar is cut for authoring, and what the open node
 * says instead. One member, because there is one seam: `queryDocument`
 * is the `$ref` that pulls the entire expression language into the
 * document grammar, and it is the same seam `programSchema({ queryRef })`
 * already leaves open. The description is what a decoder reads in place
 * of ~16 kB of phrase shapes; the vocabulary itself belongs in the
 * prompt (`operatorCrib` in `@jarenjs/ai/stylesheet`).
 */
export const JSLT_AUTHORING_OPEN = {
  queryDocument: 'A jaren-query expression: a JSONPath string starting with "$", a literal, '
    + 'or a one-member operator object such as {"$sum": "$.prices[*]"} or '
    + '{"$sub": ["$a", "$b"]}. Any JSON value decodes here; the engine compiler is the '
    + 'authority for whether it is a legal expression.',
};
