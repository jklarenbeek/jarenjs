// Run by stack-exhausted.test.js under Node with a stack of another size and
// by stack-exhausted-bun.test.js under Bun, whose engine words its refusal of
// a full call stack differently: `isStackExhausted` reads the refusal from
// the host it runs on. Prints one JSON report line.
import { isPastLongestString, isStackExhausted } from '@jarenjs/core/object';
import { CodedError } from '@jarenjs/core/errors';

/** What the host throws for a recursion without end. @param {() => number} recurse */
const refusalOf = (recurse) => { try { recurse(); } catch (error) { return error; } return undefined; };
const descend = () => 1 + descend();
const even = (n) => 1 + odd(n + 1);
const odd = (n) => 1 + even(n + 1);

const failures = [];
const host = refusalOf(descend);
if (!(host instanceof Error)) failures.push('the host threw no Error for a full stack');
if (!isStackExhausted(host)) failures.push('the host\'s refusal is not taken');
if (!isStackExhausted(refusalOf(() => even(0)))) failures.push('a refusal raised by another recursion is not taken');
if (!isStackExhausted(host)) failures.push('the refusal is not taken a second time');
// caught where the stack is still deep
const deep = (n) => (n === 0 ? isStackExhausted(refusalOf(descend)) : deep(n - 1));
if (deep(200) !== true) failures.push('a refusal caught 200 frames deep is not taken');
if (isPastLongestString(host)) failures.push('the stack refusal is taken for a string past the longest');
const others = [new RangeError('Invalid array length'), new TypeError(String(host?.message)), new Error(String(host?.message)),
  new CodedError('SchemaRuntimeError', 'JK2001', String(host?.message)), String(host?.message), { message: host?.message }, null, undefined];
others.forEach((other, i) => { if (isStackExhausted(other)) failures.push(`another value is taken: #${i}`); });
process.stdout.write(`${JSON.stringify({ runtime: typeof Bun === 'undefined' ? 'node' : 'bun', failures, refusal: `${host?.constructor?.name}: ${host?.message}` })}\n`);
