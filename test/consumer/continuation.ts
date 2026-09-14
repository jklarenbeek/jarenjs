import { sealContinuation, openContinuation, type SealContinuationOptions } from '@jarenjs/contract/continuation-node';
import type { Continuation } from '@jarenjs/contract';
const options: SealContinuationOptions = {
  scope: { tenant: 'one' }, query: 'items:v1', order: [{ column: 'id' }], now: () => 1000,
  expiresAt: 2000, keyId: 'key', key: new Uint8Array(32),
};
const token: Continuation = sealContinuation({ key: 'a' }, options);
const cursor: unknown = openContinuation(token, { ...options, getKey: id => id === 'key' ? options.key : null });
void cursor;
// @ts-expect-error signing material must be explicit bytes
sealContinuation({}, { ...options, key: 'not-key-bytes' });
// @ts-expect-error a lookup is synchronous and returns bytes or an unknown-key result
openContinuation(token, { ...options, getKey: async () => options.key });
