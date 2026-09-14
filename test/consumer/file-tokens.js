/** Public consumer: a bounded selection, an explicitly retried byte upload, then a JSON commit. */
import { createApp } from '@jarenjs/app';
import { createFileTokenRegistry } from '@jarenjs/app/file-tokens';
import { compileContract } from '@jarenjs/contract';
import { openHttpClient } from '@jarenjs/contract/client';

const contract = compileContract({ $contract: '0.1', operations: {
  upload: { kind: 'command', input: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    output: true, http: { method: 'PUT', path: '/uploads/{id}', media: 'application/octet-stream' } },
  commit: { kind: 'command', input: { type: 'object', required: ['id', 'name'],
    properties: { id: { type: 'string' }, name: { type: 'string' } } },
    output: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
    http: { method: 'POST', path: '/commits', in: { id: 'body', name: 'body' } } },
} });

export function createFileUploadConsumer({ node, fetch, runtime }) {
  const files = createFileTokenRegistry({ runtime, maxFiles: 2, maxBytes: 16, ttlMs: 1000 });
  const errors = [];
  const client = openHttpClient(contract, { baseUrl: 'https://upload.test', fetch, runtime });
  let active = null, sequence = 0, stopped = false;
  const release = Object.assign(({ tokens }) => files.release(tokens), { dispose() {
    stopped = true; active?.abort(); files.dispose(); client.close();
  } });
  const app = createApp({ state: { tokens: [] }, view: [{ match: '$', body: ['input', {
    type: 'file', multiple: true, on: { change: { action: 'pick', event: ['fileTokens'] } },
  }] }], actions: {
    pick: { $if: [{ $ne: ['$event.fileTokens', null] }, { patch: [
      { op: 'replace', path: '/tokens', value: '$event.fileTokens' },
    ] }] },
    clear: { patch: [{ op: 'replace', path: '/tokens', value: [] }] },
  } }, { node, schedule: flush => flush(), eventFields: { fileTokens(event) {
    if (app.getState().tokens.length) throw new Error('Cancel or finish the current selection first');
    return files.extract(event);
  } },
    effects: { release }, onError: error => errors.push(error) });
  return { app, files, errors,
    cancel() { active?.abort(); files.release(app.getState().tokens); app.dispatch('clear'); },
    async upload(token) {
      if (stopped || active) throw new Error('The upload owner is unavailable');
      const file = files.take(token);
      if (!file) return { ok: false, kind: 'missing-file' };
      // One taken File remains in this host scope until the bounded attempt loop settles.
      // The fixture's PUT route is replace-by-id; a product must define its own receipts.
      const controller = new AbortController(); active = controller;
      const id = `upload-${++sequence}`;
      try {
        let result;
        for (let attempt = 1; attempt <= 2; attempt++) {
          result = await client.bytes('upload', { id }, { body: file.stream(), signal: controller.signal, attempt });
          if (result.ok) { await result.value.body?.cancel(); break; }
          if (result.kind !== 'network' || controller.signal.aborted) return result;
        }
        if (!result.ok || controller.signal.aborted) return result.ok ? { ok: false, kind: 'cancelled' } : result;
        const committed = await client.invoke('commit', { id, name: file.name }, { signal: controller.signal });
        if (committed.ok && !stopped) app.dispatch('clear');
        return committed;
      } finally { active = null; }
    },
  };
}

export async function qualifyFileTokens() {
  let id = 0, sends = 0;
  const sent = [], commits = [];
  const owner = createFileUploadConsumer({ runtime: { uuid: () => `f-${++id}`, now: () => 100 },
    fetch: async (url, init) => {
      if (url.includes('/uploads/')) {
        sent.push(await new Response(init.body).text());
        if (++sends === 1) throw new TypeError('synthetic disconnected upload');
        return new Response(null, { status: 204 });
      }
      const body = JSON.parse(init.body); commits.push(body);
      return Response.json({ id: body.id });
    } });
  try {
    const file = new File(['hello'], 'hello.txt');
    owner.app.dispatch('pick', null, { target: { files: [file] } }, ['fileTokens']);
    const state = owner.app.getState();
    if (typeof state.tokens[0] !== 'string' || JSON.stringify(state).includes('hello.txt')) throw new Error('File escaped into state');
    const result = await owner.upload(state.tokens[0]);
    if (!result.ok || sent.join('|') !== 'hello|hello' || commits.length !== 1 || commits[0].name !== 'hello.txt') throw new Error('Upload retry/commit failed');
    if (owner.files.take(state.tokens[0]) !== null) throw new Error('Token was not consumed');
    owner.app.dispatch('pick', null, { target: { files: [file] } }, ['fileTokens']);
    owner.cancel();
    if (owner.files.stats().files !== 0) throw new Error('Cancellation retained a File');
    owner.app.dispatch('pick', null, { target: { files: [file] } }, ['fileTokens']);
  } finally { owner.app.destroy(); }
  if (owner.files.stats().files !== 0 || owner.files.stats().bytes !== 0) throw new Error('Destruction retained a File');
}
