//@ts-check
/** Compact traversal orders preserve the compatibility profile without retaining a trie. */

/** Build traversal ordinals from first occurrence in authoritative document order.
 * The temporary compressed tree is released before publication; only two arrays of
 * term references remain. Splitting a branch appends that branch at its parent.
 * @param {Iterable<string>} words @param {()=>void} step */
export function* lexicalVocabulary(words, step) {
  const root = [];
  for (const word of words) {
    let edges = root, offset = 0;
    while (offset < word.length) {
      step();
      const position = edges.findIndex((edge) => { step(); return edge.label && edge.label[0] === word[offset]; });
      if (position < 0) { const children = []; edges.push({ label: word.slice(offset), children }); edges = children; break; }
      const edge = edges[position];
      let shared = 0;
      while (shared < edge.label.length && word[offset + shared] === edge.label[shared]) { shared++; step(); }
      if (shared < edge.label.length) {
        const children = [{ label: edge.label.slice(shared), children: edge.children }];
        edges.splice(position, 1); edges.push({ label: edge.label.slice(0, shared), children }); edges = children;
      }
      else edges = edge.children;
      offset += shared;
    }
    edges.push({ label: '', word }); yield;
  }
  const forward = [], reverse = [], stack = [root[Symbol.iterator]()];
  while (stack.length) {
    step(); const current = stack.at(-1).next();
    if (current.done) stack.pop();
    else if (current.value.label === '') forward.push(current.value.word);
    else stack.push(current.value.children[Symbol.iterator]());
    yield;
  }
  // A reverse depth-first traversal is the reverse of the forward leaf sequence.
  for (let i = forward.length - 1; i >= 0; i--) { step(); reverse.push(forward[i]); yield; }
  return { forward, reverse };
}
