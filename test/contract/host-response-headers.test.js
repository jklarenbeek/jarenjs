//@ts-check
/**
 * @file The two seams a credential-minting command needs (WorkOps
 * JAR-021, JAR-022): `ctx.header(name, value)` arms a response header
 * the handler owns, and because the ledger records the ASSEMBLED
 * response, a replay under the same idempotency key carries the header
 * too — a refresh whose answer was lost is retried into the same
 * credential rather than into a success holding nothing. `set-cookie`
 * is the one field that repeats, so it appends and crosses both
 * adapters as distinct lines. `scope(ctx, input)` sees the validated
 * input, so a pre-auth command whose only evidence of who is asking
 * travels in its body has something to scope by.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { compileContract } from '@jarenjs/contract';
import { serveHttp } from '@jarenjs/contract/http';
import { createMemoryLedger } from '@jarenjs/contract/ledger';
import { toFetchHandler } from '@jarenjs/contract/fetch';
import { jsonReq, json } from './helpers.js';

/** A session contract: one idempotent command whose answer carries a cookie. */
const session = compileContract({
  $contract: '0.1',
  operations: {
    'session.refresh': {
      kind: 'command',
      input: { type: 'object', required: ['token'], properties: { token: { type: 'string' } } },
      output: { type: 'object', required: ['userId'], properties: { userId: { type: 'string' } } },
      policy: { idempotency: 'required' },
      http: { method: 'POST', path: '/session/refresh' },
    },
  },
});

/** @param {Record<string, any>} handlers @param {any} [options] */
const serve = (handlers, options = {}) =>
  serveHttp(session, handlers, { ledger: createMemoryLedger(), ...options });

describe('ctx.header — a response header the handler owns', () => {
  it('reaches the response, and the ledger replays it: the retry of a lost answer carries the same credential', async () => {
    let minted = 0;
    const server = serve({
      'session.refresh': (input, ctx) => {
        minted++;
        ctx.header('set-cookie', `session=s-${minted}; HttpOnly; Path=/`);
        return { userId: `u-${input.token}` };
      },
    });
    const first = await server.dispatch(jsonReq('POST', '/session/refresh', { token: 't' }, { 'idempotency-key': 'k' }));
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.headers['set-cookie'], 'session=s-1; HttpOnly; Path=/');

    // the answer was lost; the client retries under the same key
    const replay = await server.dispatch(jsonReq('POST', '/session/refresh', { token: 't' }, { 'idempotency-key': 'k' }));
    assert.strictEqual(replay.headers['idempotent-replayed'], 'true');
    assert.strictEqual(minted, 1, 'the spent token is not exchanged twice');
    assert.strictEqual(replay.headers['set-cookie'], 'session=s-1; HttpOnly; Path=/',
      'the replay carries the credential the recorded response carried');
    assert.strictEqual(replay.body, first.body);
  });

  it('set-cookie repeats and every other name replaces', async () => {
    const server = serve({
      'session.refresh': (input, ctx) => {
        ctx.header('set-cookie', 'a=1');
        ctx.header('set-cookie', 'b=2');
        ctx.header('x-tenant', 'first');
        ctx.header('X-Tenant', 'second');
        return { userId: 'u' };
      },
    });
    const response = await server.dispatch(jsonReq('POST', '/session/refresh', { token: 't' }, { 'idempotency-key': 'k' }));
    assert.deepStrictEqual(response.headers['set-cookie'], ['a=1', 'b=2']);
    assert.strictEqual(response.headers['x-tenant'], 'second');
  });

  it('the fetch adapter emits one line per repeated field rather than a comma-joined one', async () => {
    const server = serve({
      'session.refresh': (input, ctx) => {
        ctx.header('set-cookie', 'a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT');
        ctx.header('set-cookie', 'b=2');
        return { userId: 'u' };
      },
    });
    const handler = toFetchHandler(server);
    const response = await handler(new Request('http://x.test/session/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'k' },
      body: JSON.stringify({ token: 't' }),
    }));
    assert.deepStrictEqual(response.headers.getSetCookie(),
      ['a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT', 'b=2']);
  });

  it('refuses a header the binding derives, and a value that could split the response', async () => {
    /** @param {(ctx: any) => void} use */
    const run = async (use) => {
      const server = serve({ 'session.refresh': (input, ctx) => { use(ctx); return { userId: 'u' }; } });
      return json(await server.dispatch(jsonReq('POST', '/session/refresh', { token: 't' }, { 'idempotency-key': 'k' })));
    };
    // the positive control: an ordinary name is armed and answered
    const ok = await run((ctx) => ctx.header('x-mine', 'v'));
    assert.strictEqual(ok.userId, 'u', 'an ordinary header does not refuse the request');
    for (const name of ['content-type', 'Content-Length', 'etag', 'x-jaren-trace']) {
      const body = await run((ctx) => ctx.header(name, 'x'));
      assert.strictEqual(body.code, 'JC2008', `${name} is the binding's own`);
    }
    assert.strictEqual((await run((ctx) => ctx.header('x-a', 'one\r\nx-b: two'))).code, 'JC2008');
    assert.strictEqual((await run((ctx) => ctx.header('bad name', 'v'))).code, 'JC2008');
    assert.strictEqual((await run((ctx) => ctx.header('x-a', /** @type {any} */ (5)))).code, 'JC2008');
  });

  it('a failing handler sends no header it had already armed', async () => {
    const server = serve({
      'session.refresh': (input, ctx) => {
        ctx.header('set-cookie', 'session=leaked');
        throw new Error('the token was already spent');
      },
    });
    const response = await server.dispatch(jsonReq('POST', '/session/refresh', { token: 't' }, { 'idempotency-key': 'k' }));
    assert.strictEqual(response.status, 500);
    assert.strictEqual(response.headers['set-cookie'], undefined);
    // the positive control: the same arming on a handler that RETURNS is sent
    const good = serve({
      'session.refresh': (input, ctx) => { ctx.header('set-cookie', 'session=kept'); return { userId: 'u' }; },
    });
    const sent = await good.dispatch(jsonReq('POST', '/session/refresh', { token: 't' }, { 'idempotency-key': 'k' }));
    assert.strictEqual(sent.headers['set-cookie'], 'session=kept');
  });
});

describe('scope(ctx, input) — the validated input is available', () => {
  it('a pre-auth command scopes by its own body instead of by a constant', async () => {
    /** @type {any[]} */
    const seen = [];
    let runs = 0;
    const server = serve(
      { 'session.refresh': (input, ctx) => { runs++; seen.push(ctx.idempotency); return { userId: 'u' }; } },
      { scope: (ctx, input) => `token:${input.token}` });
    await server.dispatch(jsonReq('POST', '/session/refresh', { token: 'a' }, { 'idempotency-key': 'k' }));
    await server.dispatch(jsonReq('POST', '/session/refresh', { token: 'b' }, { 'idempotency-key': 'k' }));
    assert.strictEqual(runs, 2, 'one key under two body-derived scopes is two claims');
    assert.deepStrictEqual(seen, [{ key: 'k', scope: 'token:a' }, { key: 'k', scope: 'token:b' }]);
  });

  it('a scope function that takes only the context still works', async () => {
    const server = serve({ 'session.refresh': () => ({ userId: 'u' }) },
      { scope: (/** @type {any} */ ctx) => `trace-free:${ctx.carrier}` });
    const response = await server.dispatch(jsonReq('POST', '/session/refresh', { token: 'a' }, { 'idempotency-key': 'k' }));
    assert.strictEqual(response.status, 200);
  });
});

describe('an opaque operation may declare a media-type family (JAR-015)', () => {
  const downloads = compileContract({
    $contract: '0.1',
    operations: {
      'profile.image.download': {
        kind: 'read',
        input: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
        output: true,
        http: { method: 'GET', path: '/profile/{id}/image', media: 'image/*' },
      },
    },
  });

  /** @param {any} handler */
  const get = (handler) => serveHttp(downloads, { 'profile.image.download': handler }, {})
    .dispatch({ method: 'GET', url: '/profile/u1/image', headers: {}, body: null });

  it('compiles as opaque and carries the range into the projection', () => {
    const http = downloads.operations['profile.image.download'].http;
    assert.strictEqual(http.media, 'image/*');
    assert.strictEqual(http.opaque, true, 'a range is never JSON, so the bytes are the payload');
  });

  it('the handler names the exact subtype, and the binding holds it to the range', async () => {
    const png = await get(() => ({ status: 200, headers: { 'content-type': 'image/png' }, body: new Uint8Array([1, 2]) }));
    assert.strictEqual(png.status, 200);
    assert.strictEqual(png.headers['content-type'], 'image/png');
    const webp = await get(() => ({ status: 200, headers: { 'content-type': 'image/webp' }, body: new Uint8Array([3]) }));
    assert.strictEqual(webp.headers['content-type'], 'image/webp');

    // outside the range, or unnamed: the operation promised an image
    assert.strictEqual(json(await get(() =>
      ({ status: 200, headers: { 'content-type': 'text/plain' }, body: 'x' }))).code, 'JC2010');
    assert.strictEqual(json(await get(() => ({ status: 200, body: 'x' }))).code, 'JC2010');
  });

  it('a range on a JSON-bodied subscribe operation is still refused', () => {
    assert.throws(() => compileContract({
      $contract: '0.1',
      operations: {
        feed: {
          kind: 'subscribe', input: { type: 'object', properties: {} }, output: true,
          http: { method: 'GET', path: '/feed', media: 'image/*' },
        },
      },
    }), (/** @type {any} */ error) => error.code === 'JC0012');
  });
});
