//@ts-check
/**
 * @file The site's own data plane, pinned: one compiled `$contract`
 * document over @jarenjs/contract's LOCAL binding answers every fetch of
 * site-owned data — the package census, the build provenance, the
 * benchmark meta and suite files, and the repository documents the docs
 * dialog renders.
 *
 * The gate is not "it compiles". It is that the shapes the generators
 * WRITE are the shapes the browser DECLARES: the committed artifacts are
 * validated here against the very operation outputs the page reads them
 * through, and a payload that drifts from its declaration settles as a
 * typed `contract`-kind refusal rather than reaching a render. The
 * binding's honest capability set is asserted beside it, because a
 * downgrade the site did not notice would quietly turn that alarm off.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { compileContract } from '@jarenjs/contract';
import {
  siteContract, openSiteClient, createSiteHandlers, unwrap,
} from '../../packages/website/src/boundaries/site.js';
import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { createStubHost, serialize } from '../view/dom.stub.js';

const SITE = new URL('../../packages/website/', import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, SITE), 'utf8'));

const doc = read('src/contracts/site.contract.json');

/** The five operations, in the document's order. */
const IDS = ['site.packages', 'site.build', 'bench.meta', 'bench.suite', 'readme.fetch'];

const RAW = 'https://raw.githubusercontent.com/jklarenbeek/jarenjs/refs/heads/main';

/** The committed artifacts, as the browser gets them. */
const ARTIFACTS = {
  packages: read('public/site/packages.json'),
  build: read('public/build.json'),
  meta: read('public/benchmarks/meta.json'),
};

/** A client over the committed artifacts plus one fixture document. */
function openFixtureClient(overrides = {}) {
  const calls = [];
  const errors = [];
  const client = openSiteClient({
    fetchJson: (name) => {
      calls.push(`json:${name}`);
      if (name === 'meta') return Promise.resolve(overrides.meta ?? ARTIFACTS.meta);
      return Promise.resolve(read(`public/benchmarks/${name}.json`));
    },
    fetchSite: (name) => {
      calls.push(`site:${name}`);
      return Promise.resolve(overrides[name] ?? ARTIFACTS[name]);
    },
    fetchText: (url) => {
      calls.push(`text:${url}`);
      return Promise.resolve('# a document\n');
    },
    onError: (error) => errors.push(error),
  });
  return { ...client, calls, errors };
}

describe('the site contract document', function () {
  it('compiles refusal-free, and declares exactly the five site-owned reads', function () {
    const contract = compileContract(doc);
    assert.strictEqual(contract.id, 'jaren-site');
    assert.strictEqual(doc.$contract, '0.1');
    assert.strictEqual(doc.version, '1.0.0');
    assert.deepStrictEqual(contract.ids, IDS);
    for (const id of IDS) {
      const op = contract.operations[id];
      assert.strictEqual(op.kind, 'read', `${id} reads; the site writes nothing`);
      assert.ok(Object.hasOwn(op.errors, 'unavailable'),
        `${id} declares the failure a host that cannot fetch answers with`);
      assert.notStrictEqual(op.errors.unavailable.validate, null,
        `${id}'s refusal types what it could not read and why`);
      assert.strictEqual(op.http.opaque, false, `${id} is JSON the local binding can carry`);
    }
  });

  it('types the suite payloads as open, and says so rather than pretending', function () {
    const suite = siteContract.operations['bench.suite'];
    // twenty-one heterogeneous shapes: a declared unknown beats a schema
    // that would only appear to check something
    assert.strictEqual(suite.output.validate({ tables: [] }).valid, true);
    assert.strictEqual(suite.output.validate([1, 2, 3]).valid, true);
    // the input, by contrast, is bounded: a name that could escape the
    // benchmark directory never reaches a fetch
    assert.strictEqual(suite.input.validate({ suite: 'long-horizon' }).valid, true);
    assert.strictEqual(suite.input.validate({ suite: '../../etc/passwd' }).valid, false);
    assert.strictEqual(suite.input.validate({ suite: 'meta', extra: 1 }).valid, false);
  });

  it('bounds a document path to the repository, so no other origin can be reached', function () {
    const fetchOp = siteContract.operations['readme.fetch'];
    assert.strictEqual(fetchOp.input.validate({ path: 'packages/core/README.md' }).valid, true);
    assert.strictEqual(fetchOp.input.validate({ path: 'docs/DATES.md' }).valid, true);
    assert.strictEqual(fetchOp.input.validate({ path: '../secrets.md' }).valid, false);
    assert.strictEqual(fetchOp.input.validate({ path: 'https://evil.example/x.md' }).valid, false);
    assert.strictEqual(fetchOp.input.validate({ path: 'packages/core/README' }).valid, false);
  });
});

describe('the site contract over the committed artifacts', function () {
  it('validates the census, the provenance and the benchmark meta the build writes', function () {
    const ops = siteContract.operations;
    for (const [id, payload] of /** @type {[string, any][]} */ ([
      ['site.packages', ARTIFACTS.packages],
      ['site.build', ARTIFACTS.build],
      ['bench.meta', ARTIFACTS.meta],
    ])) {
      const result = ops[id].output.validate(payload);
      assert.strictEqual(result.valid, true,
        `${id}: the committed artifact must match the shape the site reads it through`);
    }
  });

  it('pins the per-row provenance the overview publishes', function () {
    const headline = siteContract.operations['bench.meta'].output;
    const row = {
      key: 'validate', label: 'JSON Schema', ratio: 1.37, rival: 'Ajv',
      conformance: '1164 / 1166', note: 'official suite',
      generated: '2026-08-21T22:33:45.416Z', node: 'v24.19.0', version: '0.39.0', quick: false,
    };
    const meta = { lastRun: ARTIFACTS.meta.lastRun, headlines: [row] };
    assert.strictEqual(headline.validate(meta).valid, true);
    // a row carried from an older file knows only its date: the three
    // unknowns are null, and null is a member the shape REQUIRES
    assert.strictEqual(headline.validate({
      ...meta, headlines: [{ ...row, node: null, version: null, quick: null }],
    }).valid, true);
    const { quick: _quick, ...withoutQuick } = row;
    assert.strictEqual(headline.validate({ ...meta, headlines: [withoutQuick] }).valid, false,
      'an omitted provenance member is a drift, not an unknown');
  });
});

describe('the site client (the local binding)', function () {
  it('declares the binding it actually runs on, output validation included', function () {
    const { capabilities } = openFixtureClient();
    assert.strictEqual(capabilities.name, 'local');
    assert.strictEqual(capabilities.validatedOutput, true,
      'the drift alarm IS the output validator; a downgrade here turns it off');
    // no wire: what this binding cannot carry, it declares false
    assert.strictEqual(capabilities.status, false);
    assert.strictEqual(capabilities.headers, false);
    assert.strictEqual(capabilities.etag, false);
    assert.strictEqual(capabilities.stream, false);
  });

  it('round-trips every operation against the artifacts the site ships', async function () {
    const site = openFixtureClient();
    const census = await site.request('site.packages');
    assert.strictEqual(census.ok, true);
    assert.ok(census.value.packages.length >= 20, 'the census answered with the published workspaces');

    const build = await site.request('site.build');
    assert.strictEqual(build.ok, true);
    assert.strictEqual(build.value.version, ARTIFACTS.build.version);

    const meta = await site.request('bench.meta');
    assert.strictEqual(meta.ok, true);
    assert.strictEqual(meta.value.headlines.length, ARTIFACTS.meta.headlines.length);

    const suite = await site.request('bench.suite', { suite: 'jsonpointer' });
    assert.strictEqual(suite.ok, true);
    assert.ok(Array.isArray(suite.value.tables), 'a suite payload passes through as it is published');

    const readme = await site.request('readme.fetch', { path: 'packages/core/README.md' });
    assert.strictEqual(readme.ok, true);
    assert.strictEqual(readme.value.url, `${RAW}/packages/core/README.md`,
      'the one raw base builds the URL — the reader gets it back for the link rewriter');
    assert.strictEqual(readme.value.text, '# a document\n');
    assert.deepStrictEqual(site.errors, [], 'nothing here is a fault');
  });

  it('fetches one document once — a reopened trail entry replays from the cache', async function () {
    const site = openFixtureClient();
    await site.request('readme.fetch', { path: 'packages/core/README.md' });
    await site.request('readme.fetch', { path: 'packages/core/docs/DATES.md' });
    const second = await site.request('readme.fetch', { path: 'packages/core/README.md' });
    assert.strictEqual(second.ok, true, 'the cached answer is a full outcome, not a shortcut past the contract');
    assert.deepStrictEqual(site.calls, [
      `text:${RAW}/packages/core/README.md`,
      `text:${RAW}/packages/core/docs/DATES.md`,
    ], 'the repeat visit never reached the network');
  });

  it('answers a host that cannot fetch with the DECLARED failure, status present and null', async function () {
    const client = openSiteClient({});
    const outcome = await client.client.invoke('site.packages');
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.kind, 'failure');
    assert.strictEqual(outcome.error.code, 'unavailable');
    assert.ok(Object.hasOwn(outcome.error, 'status'),
      'a binding that cannot carry a status carries null, it does not omit the member');
    assert.strictEqual(outcome.error.status, null);
    assert.deepStrictEqual(outcome.error.details,
      { source: 'packages', reason: 'This environment cannot load site data.' });
    // and the effects read the host's own words, not a generic refusal
    assert.deepStrictEqual(unwrap(outcome),
      { ok: false, kind: 'failure', code: 'unavailable', reason: 'This environment cannot load site data.' });
  });

  it('carries a failed fetch\'s own message through, so the dialog can show it', async function () {
    const client = openSiteClient({ fetchText: () => Promise.reject(new Error('404 Not Found')) });
    const result = unwrap(await client.client.invoke('readme.fetch', { path: 'packages/core/README.md' }));
    assert.deepStrictEqual(result,
      { ok: false, kind: 'failure', code: 'unavailable', reason: '404 Not Found' });
  });

  it('settles a MIS-SHAPED census as a contract refusal with a JC code, never as a value', async function () {
    const faults = [];
    const client = openSiteClient({
      // the census, one member off: a `packages` entry that lost its version
      fetchSite: () => Promise.resolve({
        generated: null,
        commit: null,
        packages: [{ name: '@jarenjs/core', dir: 'packages/core', description: 'Jaren Core Functions' }],
      }),
      onError: (error) => faults.push(error),
    });
    const outcome = await client.client.invoke('site.packages');
    assert.strictEqual(outcome.ok, false, 'a drifted artifact never reaches a render');
    assert.strictEqual(outcome.kind, 'contract',
      'the artifact disagreeing with its declaration is a defect, not a declared failure');
    assert.strictEqual(outcome.error.code, 'JC2070');
    assert.strictEqual(outcome.error.status, null);
    assert.strictEqual(faults.length, 1,
      'the cause behind the refusal is reported, so the diagnosis is not lost');
    assert.strictEqual(unwrap(outcome).kind, 'contract');
  });

  it('refuses an input the contract bounds before any handler runs', async function () {
    const reached = [];
    const handlers = createSiteHandlers({
      fetchJson: (name) => {
        reached.push(name);
        return Promise.resolve({});
      },
    });
    assert.deepStrictEqual(Object.keys(handlers), IDS, 'one handler per operation, no more');
    const client = openSiteClient({ fetchJson: (name) => { reached.push(name); return Promise.resolve({}); } });
    const outcome = await client.client.invoke('bench.suite', { suite: 'no/such/suite' });
    assert.strictEqual(outcome.ok, false);
    assert.strictEqual(outcome.kind, 'contract');
    assert.strictEqual(outcome.error.code, 'JC2050');
    assert.deepStrictEqual(reached, [], 'nothing ran');
  });
});

describe('the site running on its own contract', function () {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  /** The whole site headless, over a census this run decides. */
  function mount(census) {
    const { document, container } = createStubHost();
    const faults = [];
    /** @type {any} */
    let routeCb = null;
    createSiteApp({
      node: container,
      document,
      schedule: (f) => f(),
      debounceMs: 0,
      fetchJson: (name) => (name === 'meta'
        ? Promise.resolve(ARTIFACTS.meta)
        : Promise.reject(new Error('404'))),
      fetchSite: (name) => Promise.resolve(name === 'packages' ? census : ARTIFACTS.build),
      listenHash: (cb) => { routeCb = cb; cb(parseHash('#/docs')); },
      navigate: (h) => routeCb(parseHash(h)),
      onError: (error) => faults.push(error),
    });
    return { container, faults };
  }

  it('renders the rail from a census that matches its declaration', async function () {
    const { container, faults } = mount(ARTIFACTS.packages);
    await tick();
    assert.match(serialize(container), /@jarenjs\/contract/, 'the census reached the rail');
    assert.deepStrictEqual(faults, []);
  });

  it('shows the unavailable state — and reports the JC code — when the census drifts', async function () {
    const { container, faults } = mount({
      ...ARTIFACTS.packages,
      packages: ARTIFACTS.packages.packages.map(({ version: _version, ...rest }) => rest),
    });
    await tick();
    const html = serialize(container);
    assert.match(html, /Package list unavailable/,
      'a drifted artifact reaches the reader as an error state, never as a wrong render');
    assert.doesNotMatch(html, /readme-btn/, 'and no rail was built from it');
    // both halves of the diagnosis are reported: the binding's own
    // observer sees the cause (which member of which entry), and the
    // effect reports the coded refusal naming what it was reading
    const reported = faults.find((/** @type {any} */ f) => f.code === 'JC2070');
    assert.notStrictEqual(reported, undefined, 'the coded refusal is reported');
    assert.match(reported.message, /site\/packages/, 'the report names what could not be read');
    assert.ok(faults.length >= 2, 'and the cause behind it is not swallowed');
  });
});
