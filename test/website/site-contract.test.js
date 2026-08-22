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
 *
 * The same document binds the OTHER end: the generators that write those
 * artifacts prove their payloads against it before anything reaches
 * disk, and the document's own identity — its revision and the class of
 * the last change to it — is pinned beside it, so the shape cannot move
 * without someone deciding that it should.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { compileContract } from '@jarenjs/contract';
import { diffContracts } from '@jarenjs/contract/diff';
import { publicProjection } from '@jarenjs/contract/project';
import {
  siteContract, openSiteClient, createSiteHandlers, unwrap, siteContractNodes,
} from '../../packages/website/src/boundaries/site.js';
import {
  serializeSiteData, serializeSiteContent, buildSiteData, buildSiteContent,
} from '../../scripts/generate-site-data.js';
import { serializeBuildInfo, buildInfo } from '../../scripts/generate-build-info.js';
import { serializeMeta } from '../../benchmark/website-data.js';
import { git } from '../../scripts/lib/git.js';
import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { createStubHost, serialize } from '../view/dom.stub.js';

const SITE = new URL('../../packages/website/', import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, SITE), 'utf8'));

const doc = read('src/contracts/site.contract.json');

/** The six operations, in the document's order. */
const IDS = [
  'site.packages', 'site.content', 'site.build', 'bench.meta', 'bench.suite', 'readme.fetch',
];

const RAW = 'https://raw.githubusercontent.com/jklarenbeek/jarenjs/refs/heads/main';

/**
 * The artifacts, as the browser gets them — DERIVED here rather than read
 * off disk, because `public/site/` and `public/build.json` are generated
 * and gitignored: reading them made `npm test` pass only on a machine
 * that had already run a build, and fail on every clean checkout. These
 * are the same builders the generator's CLI writes with, so the payloads
 * under test are byte-for-byte the ones the site ships. The benchmark
 * overview beside them IS committed, so it stays a file read.
 */
const ARTIFACTS = {
  packages: buildSiteData(),
  content: buildSiteContent(),
  build: buildInfo(),
  meta: read('public/benchmarks/meta.json'),
};

const ROOT = new URL('../../', import.meta.url);

/**
 * Run one expression in a fresh Node process from the repository root:
 * the emit-path refusals are only worth having if they are FATAL, and
 * that is a claim about an exit code, not about a thrown value.
 * @param {string} expression
 */
function spawnNode(expression) {
  try {
    execFileSync(process.execPath, ['--input-type=module', '-e', expression],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, stderr: '' };
  }
  catch (error) {
    const e = /** @type {any} */ (error);
    return { status: e.status, stderr: String(e.stderr ?? '') };
  }
}

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
  it('compiles refusal-free, and declares exactly the six site-owned reads', function () {
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
  function mount(census, hash = '#/docs') {
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
      fetchSite: (name) => (name === 'packages'
        ? Promise.resolve(census)
        : Promise.resolve(ARTIFACTS[name])),
      listenHash: (cb) => { routeCb = cb; cb(parseHash(hash)); },
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

  it('puts the live document on the docs page — the operations, the revision, both projections', async function () {
    const { container, faults } = mount(ARTIFACTS.packages, '#/docs?s=site-contract');
    await tick();
    const html = serialize(container);
    const revision = await siteContract.revision();
    assert.match(revision, /^[0-9a-f]{64}$/);
    assert.ok(html.includes(revision),
      'the revision the page shows is the one the running contract computes');
    for (const id of IDS) {
      assert.ok(html.includes(id), `the operations table names ${id}`);
    }
    assert.ok(html.includes('The OpenAPI 3.1 projection of this document'));
    assert.ok(html.includes('The TypeScript declarations of this document'));
    assert.ok(html.includes('&quot;openapi&quot;: &quot;3.1.0&quot;')
      || html.includes('"openapi": "3.1.0"'), 'the projection is the document, rendered');
    assert.deepStrictEqual(faults, [], 'showing the contract is not a fetch and cannot fail');
  });

  it('refuses drifted site content on the READ side too — the page never renders it', async function () {
    const { document, container } = createStubHost();
    const faults = [];
    createSiteApp({
      node: container,
      document,
      schedule: (/** @type {any} */ f) => f(),
      debounceMs: 0,
      fetchJson: () => Promise.reject(new Error('404')),
      fetchSite: (/** @type {string} */ name) => Promise.resolve(name === 'content'
        ? {
          ...ARTIFACTS.content,
          packages: ARTIFACTS.content.packages.map((/** @type {any} */ entry) =>
            ({ ...entry, card: { ...entry.card, blurb: 42 } })),
        }
        : ARTIFACTS[name]),
      listenHash: (/** @type {any} */ cb) => cb(parseHash('#/docs')),
      navigate: () => {},
      onError: (/** @type {any} */ error) => faults.push(error),
    });
    await tick();
    const reported = faults.find((/** @type {any} */ f) => f.code === 'JC2070');
    assert.notStrictEqual(reported, undefined,
      'the same document that gated the write gates the read');
    assert.match(reported.message, /site\/content/);
    assert.doesNotMatch(serialize(container), /doc-md/,
      'no package section renders from content the contract refused');
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

describe('the generators write nothing the site could not read', function () {
  /** A census the site would refuse: an entry that lost its version. */
  const brokenCensus = {
    ...ARTIFACTS.packages,
    packages: ARTIFACTS.packages.packages.map(({ version: _version, ...rest }) => rest),
  };

  it('refuses a census whose shape the census operation does not declare', function () {
    assert.strictEqual(serializeSiteData(ARTIFACTS.packages),
      `${JSON.stringify(ARTIFACTS.packages, null, 2)}\n`,
      'the artifact this repository ships passes its own gate');
    assert.throws(() => serializeSiteData(brokenCensus), (/** @type {Error} */ error) => {
      assert.match(error.message, /^JC2010: /,
        'the refusal names the code the contract pipeline raises for exactly this fault');
      assert.match(error.message, /site\.packages/);
      assert.match(error.message, /site\.contract\.json\/operations\/site\.packages\/output/,
        'and the member of the document that refused it');
      assert.match(error.message, /\/packages\/0 — required/, 'and where in the payload');
      return true;
    });
  });

  it('refuses site content whose shape the content operation does not declare', function () {
    assert.strictEqual(serializeSiteContent(ARTIFACTS.content),
      `${JSON.stringify(ARTIFACTS.content, null, 2)}\n`,
      'the content this repository ships passes its own gate');
    // the card and the engine mapping are declared strictly; the parsed
    // Markdown deliberately is not, because its grammar is the one the
    // md package publishes and a copy here would be a second one
    const dropped = {
      ...ARTIFACTS.content,
      packages: ARTIFACTS.content.packages.map(({ derived: _derived, ...rest }) => rest),
    };
    assert.throws(() => serializeSiteContent(dropped), (/** @type {Error} */ error) => {
      assert.match(error.message, /^JC2010: /);
      assert.match(error.message, /site\.contract\.json\/operations\/site\.content\/output/);
      assert.match(error.message, /\/packages\/0 — required/);
      return true;
    });
    const retyped = {
      ...ARTIFACTS.content,
      packages: ARTIFACTS.content.packages.map((/** @type {any} */ entry) =>
        ({ ...entry, card: { ...entry.card, perf: 3 } })),
    };
    assert.throws(() => serializeSiteContent(retyped), /JC2010: .*site\.content/);
  });

  it('refuses build provenance the footer\'s operation does not declare', function () {
    assert.ok(serializeBuildInfo(ARTIFACTS.build).endsWith('\n'));
    const { reproducible: _reproducible, ...missing } = ARTIFACTS.build;
    assert.throws(() => serializeBuildInfo(missing), /JC2010: .*site\.build/);
    assert.throws(() => serializeBuildInfo({ ...ARTIFACTS.build, reproducible: 'yes' }),
      /JC2010: .*site\.build/, 'a retyped member is a drift too, not a detail');
  });

  it('refuses a benchmark overview the site\'s reader would refuse', function () {
    assert.strictEqual(serializeMeta(ARTIFACTS.meta), JSON.stringify(ARTIFACTS.meta));
    // the exact regression the per-row provenance exists to prevent: a
    // headline row that carries no account of the run that measured it
    const stripped = {
      ...ARTIFACTS.meta,
      headlines: ARTIFACTS.meta.headlines.map(({ generated: _generated, ...rest }) => rest),
    };
    assert.throws(() => serializeMeta(stripped), /JC2010: .*bench\.meta/);
    assert.throws(() => serializeMeta({ ...ARTIFACTS.meta, extra: true }),
      /JC2010: .*bench\.meta/, 'the document is closed: an undeclared member never ships');
  });

  it('makes the refusal fatal — a broken payload aborts the run non-zero', function () {
    const result = spawnNode(
      "import('./scripts/generate-site-data.js')"
      + '.then((m) => m.serializeSiteData({ generated: null, commit: null, packages: [{}] }))');
    assert.strictEqual(result.status, 1, 'the write is abandoned, not warned about');
    assert.match(result.stderr, /JC2010/);
  });
});

describe('the site contract\'s pinned identity', function () {
  /**
   * The pin: one payload line, `<revision> <class>`. Everything above it
   * is comment.
   *
   * TO UPDATE, after deliberately changing site.contract.json:
   *   1. run `npm run test:website` — the refusals below print both the
   *      computed revision and the computed change class;
   *   2. paste them onto the payload line, in the same commit as the
   *      document change;
   *   3. if the class is `breaking`, the generators and the browser have
   *      to ship together: every member of this document runs
   *      `additionalProperties: false`, so an artifact written by an old
   *      generator is refused by a new page and the reverse.
   * The pin is not a cache — nothing reads it at runtime. It exists so
   * that moving the shape of the site's own data plane is a decision
   * somebody made rather than a diff nobody saw.
   */
  const PIN = new URL('../../packages/website/src/contracts/site.contract.revision', import.meta.url);
  const CLASSES = ['initial', 'neutral', 'additive', 'breaking', 'unknown'];

  /** The pin's payload line, split. */
  function pinned() {
    const lines = readFileSync(PIN, 'utf8').split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    assert.strictEqual(lines.length, 1, 'the pin carries exactly one payload line');
    const [revision, changeClass, ...rest] = lines[0].split(/\s+/);
    assert.deepStrictEqual(rest, [], 'the payload line is <revision> <class> and nothing else');
    return { revision, changeClass };
  }

  /**
   * The class of a diff, worst first — the word the pin must carry.
   * @param {any} diff
   */
  function classOf(diff) {
    if (diff.breaking.length > 0) return 'breaking';
    if (diff.unknown.length > 0) return 'unknown';
    if (diff.additive.length > 0) return 'additive';
    if (diff.neutral.length > 0) return 'neutral';
    return 'unchanged';
  }

  it('pins the revision the compiled document actually has', async function () {
    const { revision } = pinned();
    assert.match(revision, /^[0-9a-f]{64}$/, 'a revision is 64 lowercase hex characters');
    assert.strictEqual(revision, await siteContract.revision(),
      'the document moved without its pin: paste the revision above onto the pin\'s payload line');
  });

  it('states the class of the change that produced it', function () {
    const { changeClass } = pinned();
    assert.ok(CLASSES.includes(changeClass),
      `the class is one of ${CLASSES.join(' | ')}, got '${changeClass}'`);
  });

  it('agrees with what changed since the last committed document', function () {
    const head = git('show', `HEAD:${'packages/website/src/contracts/site.contract.json'}`);
    if (head === null) {
      // a tarball, a shallow checkout, or the document is new: there is
      // no previous side to diff against, and inventing one would be a
      // worse answer than saying so
      return;
    }
    const diff = diffContracts(
      publicProjection(compileContract(JSON.parse(head))),
      publicProjection(siteContract));
    const computed = classOf(diff);
    if (computed === 'unchanged') return;
    assert.strictEqual(pinned().changeClass, computed,
      `the working document differs from HEAD as '${computed}' — say so on the pin's payload line`);
  });
});

describe('the docs page shows the document it runs on', function () {
  const CAPABILITIES = {
    name: 'local', status: false, headers: false, media: false, etag: false,
    idempotency: false, validatedOutput: true, stream: false, cancel: 'signal',
  };

  it('renders the operations table, the revision and both projections from the live document', async function () {
    const revision = await siteContract.revision();
    const nodes = siteContractNodes({ revision, capabilities: CAPABILITIES }, 'ready');
    const table = nodes.find((n) => n.kind === 'table');
    assert.deepStrictEqual(table.head,
      ['operation', 'kind', 'canonical binding', 'input members', 'declared errors']);
    assert.deepStrictEqual(table.rows.map((/** @type {any} */ r) => r.cells[0]), IDS,
      'every operation of the running contract is in the table, in document order');
    for (const row of table.rows) {
      assert.strictEqual(row.cells[1], 'read');
      assert.strictEqual(row.cells[4], 'unavailable');
    }
    const hex = nodes.find((n) => n.kind === 'code' && n.title === 'revision()');
    assert.match(hex.text, /^[0-9a-f]{64}$/, 'the revision renders in full, not truncated');
    assert.strictEqual(hex.text, revision);

    const summaries = nodes.filter((n) => n.kind === 'details').map((n) => n.summary);
    assert.deepStrictEqual(summaries, [
      'The OpenAPI 3.1 projection of this document',
      'The TypeScript declarations of this document',
    ]);
    const [openapi, types] = nodes.filter((n) => n.kind === 'details');
    const document = JSON.parse(openapi.items[0].text);
    assert.strictEqual(document.openapi, '3.1.0');
    assert.strictEqual(document.info.title, 'jaren-site');
    assert.ok(types.items[0].text.includes('jaren-site'),
      'the TypeScript projection is the site\'s own contract, not a sample');
  });

  it('states the capabilities the RUNNING client publishes, not a written-down copy', async function () {
    const { capabilities } = openSiteClient({});
    assert.deepStrictEqual({ ...capabilities }, CAPABILITIES,
      'the docs copy is derived from this object; a binding change must move both');
    const nodes = siteContractNodes(
      { revision: await siteContract.revision(), capabilities }, 'ready');
    const [operations, binding, validation] = nodes.find((n) => n.kind === 'cards').items;
    assert.strictEqual(operations.value, String(IDS.length));
    assert.strictEqual(operations.note, 'every one a read');
    assert.strictEqual(binding.value, 'local');
    assert.strictEqual(validation.value, 'on');
    const honest = nodes.find((n) => n.kind === 'callout'
      && n.title === 'Honestly reduced, not quietly degraded');
    for (const word of ['status codes', 'headers', 'non-JSON media', 'etags',
      'idempotency keys', 'streams']) {
      assert.ok(honest.text.includes(word), `the copy names the ${word} it cannot carry`);
    }
  });

  it('says what it is waiting for before the digest settles, and never a wrong hex', function () {
    for (const [status, title] of [[undefined, 'Computing the revision…'], ['loading', 'Computing the revision…'], ['error', 'Revision unavailable']]) {
      const nodes = siteContractNodes(undefined, status);
      assert.strictEqual(nodes.find((n) => n.kind === 'callout').title, title);
      assert.strictEqual(nodes.find((n) => n.kind === 'code' && n.title === 'revision()'), undefined);
      assert.ok(nodes.some((n) => n.kind === 'table'),
        'the document-derived half needs no digest and renders anyway');
    }
  });
});
