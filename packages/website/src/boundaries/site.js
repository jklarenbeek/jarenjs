//@ts-check
/**
 * @file The site's own data plane: every fetch of site-owned data — the
 * package census, the build provenance, the benchmark meta and suite
 * files, and the repository READMEs the docs dialog renders — resolves
 * through one compiled `$contract` document
 * (`../contracts/site.contract.json`) on @jarenjs/contract's LOCAL
 * binding.
 *
 * There is no server and no wire: GitHub Pages is static, so the
 * handlers are thin wrappers over the host's fetch capabilities and
 * `openLocalClient` supplies the pipeline — one input validation, one
 * output validation, one D6 outcome. Output validation stays ON, which
 * is the point of the arrangement: the generator that writes an
 * artifact and the browser that reads it declare its shape in the SAME
 * document, so a drifted artifact settles as a typed `contract`-kind
 * refusal the page reports, never as a silently wrong render.
 *
 * A host that cannot fetch at all (a headless test, a no-network
 * embedding) is not a fault: the operation answers the declared
 * `unavailable` failure naming what it went for and why, and the
 * surfaces then say what they could not load.
 */

import { compileContract } from '@jarenjs/contract';
import { openLocalClient } from '@jarenjs/contract/local';

import contractDoc from '../contracts/site.contract.json' with { type: 'json' };
import { rawUrl } from './markdown.js';

/** The site's data-plane contract, compiled once for the page. */
export const siteContract = compileContract(contractDoc);

/**
 * The site's fetch capabilities, as `createSiteApp` receives them.
 * @typedef {Object} SiteFetchers
 * @property {(name: string) => Promise<any>} [fetchJson] - Benchmark files by suite name.
 * @property {(name: string) => Promise<any>} [fetchSite] - Build-generated site data.
 * @property {(url: string) => Promise<string>} [fetchText] - Raw text by URL.
 */

/**
 * What an effect gets back: the value, or the refusal with the code to
 * report and the reason a reader can be shown.
 * @typedef {{ ok: true, value: any }
 *   | { ok: false, kind: string, code: string, reason: string }} SiteResult
 */

/**
 * Map a D6 outcome onto the shape the effects dispatch from. A declared
 * failure carries the host's own message in its details, so a fetch
 * error still reads as `404 Not Found` rather than as a generic
 * refusal; every other kind carries the binding's `JC` code, which is
 * what a schema disagreement between generator and browser looks like.
 * @param {any} outcome
 * @returns {SiteResult}
 */
export function unwrap(outcome) {
  if (outcome.ok) return { ok: true, value: outcome.value };
  const details = outcome.error.details;
  const reason = details !== null && typeof details === 'object' && typeof details.reason === 'string'
    ? details.reason
    : outcome.error.message;
  return { ok: false, kind: outcome.kind, code: outcome.error.code, reason };
}

/**
 * A missing host capability is a declared failure, not a thrown fault:
 * the page asked for something this environment cannot answer.
 * @param {any} ctx
 * @param {string} source
 * @param {string} reason
 */
const missing = (ctx, source, reason) => ctx.fail('unavailable', { source }, { source, reason });

/** The message of a rejected fetch, as the reader should see it. */
const because = (/** @type {any} */ error) =>
  (typeof error?.message === 'string' && error.message !== '' ? error.message : String(error));

/**
 * The handler table: one thin wrapper per operation over the injected
 * fetch capabilities. Nothing here decides a shape — the contract does
 * — so a handler is exactly "go get it, or say why not".
 * @param {SiteFetchers} env
 * @returns {Record<string, any>}
 */
export function createSiteHandlers(env) {
  /** README text by raw URL: reopening a document, or stepping back
   * through the dialog's trail, must not hit the network again. */
  const readmeCache = new Map();

  /**
   * @param {(name: string) => Promise<any>} [fetcher]
   * @param {string} name
   * @param {any} ctx
   */
  const json = async (fetcher, name, ctx) => {
    if (fetcher === undefined) return missing(ctx, name, 'This environment cannot load site data.');
    try {
      return await fetcher(name);
    }
    catch (error) {
      return missing(ctx, name, because(error));
    }
  };

  return {
    'site.packages': (_input, ctx) => json(env.fetchSite, 'packages', ctx),
    'site.build': (_input, ctx) => json(env.fetchSite, 'build', ctx),
    'bench.meta': (_input, ctx) => json(env.fetchJson, 'meta', ctx),
    'bench.suite': (input, ctx) => json(env.fetchJson, input.suite, ctx),
    'readme.fetch': async (input, ctx) => {
      const url = rawUrl(input.path);
      const cached = readmeCache.get(url);
      if (cached !== undefined) return { url, text: cached };
      if (env.fetchText === undefined) {
        return missing(ctx, input.path, 'README loading is unavailable in this environment.');
      }
      let text;
      try {
        text = await env.fetchText(url);
      }
      catch (error) {
        return missing(ctx, input.path, because(error));
      }
      readmeCache.set(url, text);
      return { url, text };
    },
  };
}

/**
 * Open the site's data plane.
 * @param {SiteFetchers & { onError?: (error: unknown, ctx: any) => void }} [env]
 * @returns {{ client: any, capabilities: any, request: (op: string, input?: any) => Promise<SiteResult> }}
 */
export function openSiteClient(env = {}) {
  const client = openLocalClient(siteContract, createSiteHandlers(env), {
    // the cause behind a JC2070 — the output the artifact actually
    // carried against the shape it declares — is the whole diagnostic
    // value of running with validation on, so it is reported, never dropped
    onError: env.onError,
  });
  return {
    client,
    capabilities: client.capabilities,
    request: async (op, input) => unwrap(await client.invoke(op, input)),
  };
}
