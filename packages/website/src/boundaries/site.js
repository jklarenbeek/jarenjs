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
 *
 * The docs page shows this arrangement rather than describing it:
 * `siteContractNodes` renders the LIVE document — its `describe()`
 * summary, its revision and its OpenAPI and TypeScript projections —
 * from the same compiled object the page is reading through while the
 * reader looks at it.
 */

import { compileContract } from '@jarenjs/contract';
import { openLocalClient } from '@jarenjs/contract/local';
import { toOpenApi, toTypeScript } from '@jarenjs/contract/project';

import contractDoc from '../contracts/site.contract.json' with { type: 'json' };
import { p, cards, table, code, callout, details } from '../lib/nodes.js';
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

/**
 * The heavy projections of the site's own document. Both are pure
 * functions of a frozen contract, so they are computed once and shared;
 * `describe()` is not cached because its `revision` member fills in only
 * after the digest settles.
 * @type {{ openapi: any, types: string } | null}
 */
let projections = null;

/** @returns {{ openapi: any, types: string }} */
function siteProjections() {
  if (projections === null) {
    projections = {
      // lenient: a keyword the OpenAPI dialect cannot carry is dropped
      // and COUNTED — the page then says so — rather than refusing the
      // whole section; refusing is the CLI's job, showing is this one's
      openapi: toOpenApi(siteContract, {
        lenient: true,
        info: { title: siteContract.id, version: siteContract.version },
      }),
      types: toTypeScript(siteContract),
    };
  }
  return projections;
}

/** Capability slots this binding answers `false` to, in reader's words. */
const CANNOT_CARRY = [
  ['status', 'status codes'], ['headers', 'headers'], ['media', 'non-JSON media'],
  ['etag', 'etags'], ['idempotency', 'idempotency keys'], ['stream', 'streams'],
];

/**
 * The revision, or an honest account of why it is not there yet. It is a
 * digest over canonical bytes, so it arrives one microtask after the
 * page does — and a host without SubtleCrypto never gets it at all.
 * @param {string | undefined} status
 */
const pending = (status) => (status === 'error'
  ? callout('Revision unavailable',
    'This browser could not hash the contract\'s public projection, so the site cannot show its revision.')
  : callout('Computing the revision…',
    'The digest runs over the canonical bytes of the document\'s public projection.'));

/**
 * The live account of the site's own data plane, for the docs page:
 * everything here is read off the compiled contract the page is running
 * on at the moment it renders, so it cannot describe a document the site
 * does not actually use.
 * @param {{ revision: string, capabilities: any } | undefined} info -
 *   The revision and the running client's capabilities, once computed.
 * @param {string | undefined} status - The status of that computation.
 * @returns {any[]} render nodes for the docs section.
 */
export function siteContractNodes(info, status) {
  const description = siteContract.describe();
  const { openapi, types } = siteProjections();
  const kinds = [...new Set(description.operations.map((/** @type {any} */ o) => o.kind))];
  const rows = description.operations.map((/** @type {any} */ op) => {
    const members = Object.keys(op.in);
    return {
      cells: [
        op.id,
        op.kind,
        `${op.method} ${op.path}`,
        members.length === 0 ? '—' : members.join(', '),
        Object.keys(siteContract.operations[op.id].errors).join(', ') || '—',
      ],
    };
  });
  return [
    p('That is the layer as a library. This page is also a consumer of it: every read of the site\'s own data — the package census in the rail beside you, the build provenance in the footer, the benchmark overview and each suite file, and the repository documents the README dialog renders — goes through one $contract document compiled in your browser. What follows is not a transcription of it; it is that document, described by itself while you read.'),
    ...(info === undefined ? [pending(status)] : [
      cards([
        {
          title: 'Operations',
          value: String(description.operations.length),
          note: kinds.length === 1 ? `every one a ${kinds[0]}` : kinds.join(' / '),
        },
        { title: 'Binding', value: info.capabilities.name, note: 'in-process — there is no server to call' },
        {
          title: 'Output validation',
          value: info.capabilities.validatedOutput ? 'on' : 'off',
          note: 'the alarm that catches a drifted artifact',
        },
      ]),
      code('revision()', info.revision, 'public projection · RFC 8785 · SHA-256'),
    ]),
    table('The operations, from describe()',
      ['operation', 'kind', 'canonical binding', 'input members', 'declared errors'],
      rows,
      'The binding column is the REST shape the compiler resolved for each operation. Nothing on this site ever calls it: the same compiled document is served in-process, which is why the site can run on a contract while being a directory of static files.'),
    details('The OpenAPI 3.1 projection of this document', [
      ...(openapi.dropped.length === 0 ? [] : [p(`The OpenAPI dialect cannot carry every JSON Schema keyword this document uses: ${openapi.dropped.length} were dropped from the projection below. The contract, not the projection, is what the site validates against.`)]),
      code(null, JSON.stringify(openapi.document, null, 2)),
    ]),
    details('The TypeScript declarations of this document', [code(null, types)]),
    ...(info === undefined ? [] : [
      callout('Honestly reduced, not quietly degraded',
        `A binding publishes what it can carry, and this one carries less than HTTP: ${
          CANNOT_CARRY.filter(([slot]) => info.capabilities[slot] === false).map(([, word]) => word).join(', ')
        }. Those slots are read off the running client rather than written down here, and the capability table above shows the same binding beside http and port. Every operation is a read, nothing is stored, and no request leaves the page.`),
    ]),
  ];
}
