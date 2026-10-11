//@ts-check
/**
 * A closed data transport refuses every call the same way. `request` named
 * the closed transport; `subscribe` read a property of the cleared client
 * and threw a TypeError about `null` — what a live-query subscription
 * started after the page left would have surfaced.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { createTransport } from '@jarenjs/studio/data';

describe('createTransport — a closed transport', function () {
  const closed = () => {
    const transport = createTransport({
      spawnWorker() { throw new Error('no worker'); },
      openChannel() { throw new Error('no channel'); },
    });
    transport.close();
    return transport;
  };

  it('refuses a request by name', async () => {
    await assert.rejects(closed().request('data.init', null), { message: 'the data transport is closed' });
  });

  it('refuses a subscription by name, as a request does', () => {
    assert.throws(() => closed().subscribe({}, {}), { name: 'Error', message: 'the data transport is closed' });
  });
});
