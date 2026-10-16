// Run by text-length-bun.test.js under Bun, whose longest string is longer
// than V8's and whose refusal of a longer one says so in words of its own:
// a key past it is refused as Node refuses one past V8's, and a key that
// V8 cannot hold but Bun can is written whole. Prints one JSON report line.
import { contentKey, semanticKey, stableStringify } from '@jarenjs/core/object';

/** `n` levels of `d = [d, d]`. @param {number} n */
const dag = (n) => {
  /** @type {any} */
  let d = 0;
  for (let i = 0; i < n; i++) d = [d, d];
  return d;
};
const failures = [];
for (const [key, verb] of [[stableStringify, 'serialized'], [semanticKey, 'a cache identity'], [contentKey, 'serialized']]) {
  try {
    key(dag(40));
    failures.push(`${key.name}: answered`);
  }
  catch (error) {
    const expected = `JO2009: a value whose text is longer than the host's longest string cannot be ${verb}`;
    if (error.name !== 'JsonLengthError' || error.code !== 'JO2009' || error.message !== expected)
      failures.push(`${key.name}: ${error.name} ${error.code} ${error.message}`);
  }
}
// 536870909 characters: past V8's longest string, within Bun's
if (stableStringify(dag(27)).length !== 536870909)
  failures.push('stableStringify(dag(27)) is not whole');
if (semanticKey(dag(27)).length !== 536870909)
  failures.push('semanticKey(dag(27)) is not whole');
process.stdout.write(`${JSON.stringify({ runtime: typeof Bun === 'undefined' ? 'node' : 'bun', failures })}\n`);
