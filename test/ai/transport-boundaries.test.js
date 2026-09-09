//@ts-check
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { createChatClient, createEmbeddingClient, AiError } from '@jarenjs/ai';

it('a malformed nonstreaming completion retries and can recover', async () => {
  let calls = 0;
  const client = createChatClient({ provider: 'ollama', model: 'fixture',
    retry: { attempts: 2, sleep: async () => {} },
    fetch: async () => ++calls === 1 ? new Response('{broken')
      : Response.json({ choices: [{ message: { content: 'recovered' } }] }),
  });
  const result = await client.complete({ messages: [{ role: 'user', content: 'hello' }], stream: false });
  assert.equal(result.message.content, 'recovered');
  assert.equal(calls, 2);
});

it('persistent malformed nonstreaming completions report the configured attempts', async () => {
  for (const body of ['not JSON', '{broken']) {
    let calls = 0;
    const client = createChatClient({ provider: 'ollama', model: 'fixture',
      retry: { attempts: 2, sleep: async () => {} },
      fetch: async () => { calls++; return new Response(body); },
    });
    await assert.rejects(client.complete({ messages: [{ role: 'user', content: 'hello' }], stream: false }),
      (error) => error instanceof AiError && error.code === 'AI0003' && error.attempts === 2);
    assert.equal(calls, 2);
  }
});

for (const kind of ['chat', 'embedding']) {
  it(`${kind}: cancellation preserves any signal reason and never retries`, async () => {
    for (const attempts of [1, 3]) {
      for (const reason of [undefined, null, false, 'cancel', new Error('cancel'),
        new AiError('AI0002', 'caller cancelled', { status: 503 })]) {
        const controller = new AbortController();
        let calls = 0;
        let waits = 0;
        const options = { provider: 'ollama', model: 'fixture', retry: { attempts,
          sleep: async () => { waits++; } }, fetch: async () => {
          calls++;
          controller.abort(reason);
          throw controller.signal.reason;
        } };
        const promise = kind === 'chat'
          ? createChatClient(options).complete({ messages: [{ role: 'user', content: 'hello' }],
            signal: controller.signal })
          : createEmbeddingClient(options).embed(['hello'], { signal: controller.signal });
        await assert.rejects(promise, (error) => error === controller.signal.reason);
        assert.equal(calls, 1);
        assert.equal(waits, 0);
      }
    }
  });
}
