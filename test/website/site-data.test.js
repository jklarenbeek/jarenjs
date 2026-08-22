//@ts-check
/**
 * @file The site's generated data, gated: the package census the docs
 * rail renders, the site documents the workspaces own, and the build
 * provenance the footer shows.
 *
 * The census exists because the site used to keep its package list as
 * source, and source drifts — three published workspaces were missing
 * from it. So the gate is not "the generator runs": it is that the
 * census equals the root manifest's public workspaces, walked here
 * INDEPENDENTLY of the generator. Add a workspace and forget the site,
 * and this suite fails.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { JarenValidator } from '@jarenjs/validate';

import {
  buildSiteData, serializeSiteData, buildSiteContent, serializeSiteContent,
  readSiteDocument, derivedCard,
} from '../../scripts/generate-site-data.js';
import { DOCS_SECTIONS } from '../../packages/website/src/content/docs.js';
import { buildInfo, serializeBuildInfo } from '../../scripts/generate-build-info.js';
import { git, headCommit, isDirty } from '../../scripts/lib/git.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const read = (...parts) => JSON.parse(readFileSync(join(ROOT, ...parts), 'utf8'));

/**
 * Run one expression in a fresh Node process from the repository root:
 * a refusal is only worth having if it is FATAL, and that is a claim
 * about an exit code, not about a thrown value.
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

/** The public workspaces, walked from the root manifest without the generator. */
function publicWorkspaces() {
  return read('package.json').workspaces
    .map((/** @type {string} */ entry) => entry.replace(/^\.\//, ''))
    .filter((/** @type {string} */ dir) => read(dir, 'package.json').private !== true);
}

describe('the package census (scripts/generate-site-data.js)', function () {
  it('lists exactly the root manifest\'s public workspaces, in manifest order', function () {
    const census = buildSiteData();
    const dirs = publicWorkspaces();
    assert.deepStrictEqual(census.packages.map((p) => p.dir), dirs,
      'a workspace added to the root manifest must appear on the site');
    for (const entry of census.packages) {
      const manifest = read(entry.dir, 'package.json');
      assert.strictEqual(entry.name, manifest.name);
      assert.strictEqual(entry.version, manifest.version);
      assert.strictEqual(entry.description, manifest.description);
    }
    // the three newest workspaces are the reason this gate exists
    const names = census.packages.map((p) => p.name);
    for (const name of ['@jarenjs/contract', '@jarenjs/studio', '@jarenjs/play']) {
      assert.ok(names.includes(name), `${name} is in the census`);
    }
    assert.ok(!names.includes('@jarenjs/website'), 'private workspaces stay out of a published list');
  });

  it('names a directory that really carries the README the site links to', function () {
    for (const entry of buildSiteData().packages) {
      assert.ok(existsSync(join(ROOT, entry.dir, 'README.md')),
        `${entry.name}: ${entry.dir}/README.md exists`);
    }
  });

  it('describes every package — the rail has no blank tooltips', function () {
    for (const entry of buildSiteData().packages) {
      assert.ok(typeof entry.description === 'string' && entry.description.trim() !== '',
        `${entry.name} carries a description`);
    }
  });

  it('is byte-identical run over run — the timestamp is the commit, not the clock', function () {
    const first = serializeSiteData(buildSiteData());
    const second = serializeSiteData(buildSiteData());
    assert.strictEqual(first, second);
    const { commit, committed } = headCommit();
    const census = buildSiteData();
    assert.strictEqual(census.commit, commit);
    assert.strictEqual(census.generated, committed);
  });
});

describe('the build provenance (scripts/generate-build-info.js)', function () {
  it('carries the version, the revision and the commit date the footer prints', function () {
    const info = buildInfo();
    assert.strictEqual(info.version, read('package.json').version);
    assert.strictEqual(info.commit, git('rev-parse', 'HEAD'));
    assert.match(info.built, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('claims reproducible only for a committed revision AND a clean tree', function () {
    const dirty = isDirty();
    const expected = headCommit().committed !== null && dirty === false;
    assert.strictEqual(buildInfo().reproducible, expected,
      'uncommitted changes are in the bundle but not in the commit it names');
  });

  it('records the runtime it was built on as a build-environment fact', function () {
    const info = buildInfo();
    assert.strictEqual(info.node, process.version);
    assert.strictEqual(info.platform, `${process.platform} ${process.arch}`);
  });

  it('is byte-identical run over run, like the two artifacts beside it', function () {
    // the third of the three generators the build runs, and the one whose
    // timestamp would be the clock if `built` were not the commit date:
    // a rebuild of one revision has to produce one bundle
    assert.strictEqual(serializeBuildInfo(buildInfo()), serializeBuildInfo(buildInfo()));
  });
});

//#region the site documents the workspaces own

/**
 * The inversion: a workspace describes its own presence on the site in
 * `site.md` beside its manifest, and the collector validates it, parses
 * it and ships it. The gate has three halves.
 *
 * A document that cannot be trusted must ABORT the build, named by its
 * path — a package silently dropped from the site is exactly the class
 * of drift the census gate above exists to prevent, and a bad document
 * must not reintroduce it through the back door.
 *
 * A workspace that has written no document must still render: it gets a
 * card derived from its manifest, marked as derived, so a partly
 * migrated repository shows every package honestly rather than showing
 * the migrated ones and hiding the rest.
 *
 * And the document is a REPO concern, not consumer API: it must never
 * enter an npm tarball.
 */
describe('a workspace\'s own site document (site.md)', function () {
  const OK = [
    '---',
    'package: "@jarenjs/play"',
    'card:',
    '  title: Play',
    '  blurb: The engine playground.',
    '  perf: understand an engine standalone',
    'engines:',
    '  - key: play',
    '    suite: markdown',
    '---',
    '',
    '# Play',
    '',
    'One pane holds the program, the other the data.',
    '',
  ].join('\n');

  /** The document with one frontmatter line replaced, for the refusals. */
  const withLine = (find, replace) => OK.replace(find, replace);

  /** The fixture, read as `components/play/site.md`. */
  const parse = (source, name = '@jarenjs/play') =>
    readSiteDocument('components/play', source, name);

  it('reads the card, the engine mapping and the body of a good document', function () {
    const entry = parse(OK);
    assert.strictEqual(entry.name, '@jarenjs/play');
    assert.strictEqual(entry.derived, false, 'a workspace that wrote one owns its card');
    assert.deepStrictEqual(entry.card,
      { title: 'Play', blurb: 'The engine playground.', perf: 'understand an engine standalone' });
    assert.deepStrictEqual(entry.engines, [{
      key: 'play', suite: 'markdown',
      // an entry that states only its key and suite is measured by the
      // package's own card — one card, written once
      card: { title: 'Play', blurb: 'The engine playground.', perf: 'understand an engine standalone' },
    }]);
    assert.strictEqual(entry.docs.$md, '0.1');
    assert.deepStrictEqual(entry.docs.ast.map((/** @type {any} */ n) => n.type),
      ['heading', 'paragraph']);
  });

  it('accepts a card-only document — a package may want no docs section', function () {
    const entry = parse(OK.slice(0, OK.indexOf('# Play')));
    assert.strictEqual(entry.docs, null, 'no body is a decision, not a fault');
    assert.strictEqual(entry.card.title, 'Play');
  });

  it('carries the optional members as null rather than leaving them out', function () {
    const entry = parse([
      '---', 'package: "@jarenjs/play"', 'card:', '  title: Play', '  blurb: x', '---', '',
    ].join('\n'));
    assert.strictEqual(entry.card.perf, null);
    assert.deepStrictEqual(entry.engines, [], 'a package that is not an engine contributes no card');
  });

  /**
   * The four ways a document is refused. Each names the path, because
   * "the site build failed" without one is a hunt through 22 workspaces.
   */
  const REFUSALS = [
    ['broken frontmatter', withLine('  title: Play', '  title: [unclosed'), 'the frontmatter is malformed'],
    ['an unknown member', withLine('  title: Play', '  title: Play\n  tagline: nope'),
      'does not match packages/website/schemas/site-document.schema.json'],
    ['a package name that is not the one beside it', OK.replace('@jarenjs/play', '@jarenjs/core'),
      "names package '@jarenjs/core', but the manifest beside it is '@jarenjs/play'"],
    ['a body the parser cannot read', `${OK}${'>'.repeat(50000)} x\n`,
      'the body is not readable as markdown'],
  ];

  for (const [what, source, reason] of REFUSALS) {
    it(`refuses ${what}, naming the document`, function () {
      assert.throws(() => parse(source), (/** @type {Error} */ error) => {
        assert.match(error.message, /^components\/play\/site\.md: /,
          'the refusal opens with the path of the document at fault');
        assert.ok(error.message.includes(reason), `it says why: ${error.message.split('\n')[0]}`);
        return true;
      });
    });
  }

  it('refuses a document with no frontmatter at all', function () {
    assert.throws(() => parse('# Play\n\nJust prose.\n'),
      /components\/play\/site\.md: carries no frontmatter object/);
  });

  it('refuses a figure in the authored perf line — that line is voice, not measurement', function () {
    assert.throws(() => parse(withLine('  perf: understand an engine standalone', '  perf: 3x faster')),
      /site-document\.schema\.json/);
  });

  it('a refusal is fatal in a real process, not a warning', function () {
    const [, source] = REFUSALS[0];
    const module = new URL('../../scripts/generate-site-data.js', import.meta.url).href;
    const result = spawnNode(`import('${module}')`
      + `.then((m) => m.readSiteDocument('components/play', ${JSON.stringify(source)},`
      + ' \'@jarenjs/play\'))');
    assert.notStrictEqual(result.status, 0, 'the build stops rather than shipping the document');
    assert.match(result.stderr, /components\/play\/site\.md/);
  });
});

describe('the collected site content', function () {
  const content = buildSiteContent();

  it('carries one entry per public workspace, in the census\'s order', function () {
    assert.deepStrictEqual(content.packages.map((/** @type {any} */ e) => e.name),
      buildSiteData().packages.map((/** @type {any} */ e) => e.name));
  });

  it('gives every workspace a card — a derived one where none was written', function () {
    // this is the zero-documents state, computed workspace by workspace:
    // whatever any of them has committed, the manifest can always answer
    for (const dir of publicWorkspaces()) {
      const manifest = read(dir, 'package.json');
      const card = derivedCard(manifest);
      assert.strictEqual(card.blurb, manifest.description);
      assert.ok(card.title.length > 0 && card.blurb.trim() !== '',
        `${manifest.name}: a fallback card still says what the package is`);
      assert.strictEqual(card.perf, null, 'a derived card claims nothing about performance');
    }
    for (const entry of content.packages) {
      assert.ok(entry.card.title.length > 0 && entry.card.blurb.trim() !== '',
        `${entry.name}: every entry carries a card`);
    }
  });

  it('has every published workspace owning its document — none derived', function () {
    const derived = content.packages.filter((/** @type {any} */ e) => e.derived);
    assert.deepStrictEqual(derived.map((/** @type {any} */ e) => e.name), [],
      'a workspace still described by its manifest has not written its site.md yet');
    assert.strictEqual(content.packages.length, publicWorkspaces().length);
  });

  it('carries a documentation section for every published workspace', function () {
    // a card-only document is a decision the grammar allows, and one no
    // workspace makes any more; a package that quietly stopped writing a
    // body would be the site quietly losing a section
    const cardOnly = content.packages
      .filter((/** @type {any} */ e) => e.docs === null)
      .map((/** @type {any} */ e) => e.name);
    assert.deepStrictEqual(cardOnly, [],
      'every workspace documents itself on the docs page, in its own words');
  });

  it('collects the engine grid from the packages, several from one workspace', function () {
    const byPackage = new Map(content.packages
      .map((/** @type {any} */ e) => [e.name, e.engines.map((/** @type {any} */ x) => x.key)]));
    // the grid is a list of ENGINES, and @jarenjs/json publishes six of
    // them: one card per package would have hidden five
    assert.deepStrictEqual(byPackage.get('@jarenjs/json'),
      ['path', 'pointer', 'patch', 'query', 'jslt', 'jtlt']);
    assert.deepStrictEqual(byPackage.get('@jarenjs/josl'), ['josl', 'csv']);
    assert.deepStrictEqual(byPackage.get('@jarenjs/contract'), ['contract']);
    // and a package that is not an engine contributes no card
    assert.deepStrictEqual(byPackage.get('@jarenjs/studio'), []);
    assert.deepStrictEqual(byPackage.get('@jarenjs/locales'), []);
    const keys = content.packages.flatMap((/** @type {any} */ e) =>
      e.engines.map((/** @type {any} */ x) => x.key));
    assert.deepStrictEqual([...new Set(keys)], keys, 'two packages claiming one key would render twice');
    for (const entry of content.packages) {
      for (const engine of entry.engines) {
        assert.ok(engine.card.title.length > 0 && engine.card.blurb.trim() !== '',
          `${entry.name}: the ${engine.key} card says what the engine is`);
      }
    }
  });

  it('ships documentation sections that are valid Markdown documents', function () {
    // the parser is the authority on the AST; this is the drift gate
    // between the grammar @jarenjs/md publishes and what lands in the
    // artifact the browser renders
    const schema = JSON.parse(readFileSync(
      join(ROOT, 'components/md/schemas/jaren-md-ast.schema.json'), 'utf8'));
    const validate = new JarenValidator({ skipErrors: false, collectErrors: true }).compile(schema);
    for (const entry of content.packages) {
      if (entry.docs === null) continue;
      const result = validate(entry.docs);
      assert.strictEqual(result.valid, true,
        `${entry.name}: ${JSON.stringify(result.errors?.slice(0, 3))}`);
      assert.strictEqual(entry.docs.meta.sourceUrl.endsWith('/site.md'), true,
        'the document says which file it came from');
    }
  });

  it('is byte-identical run over run, like the census beside it', function () {
    assert.strictEqual(serializeSiteContent(buildSiteContent()),
      serializeSiteContent(buildSiteContent()));
  });

  it('refuses two workspaces claiming one engine key', function () {
    // the key is a name in a namespace twenty-two independently committed
    // documents share, and every lookup over the collected engines
    // resolves it to the FIRST match — so the second claimant would not
    // render as a conflict but as a duplicate card whose measured line
    // silently belongs to the other package
    const root = mkdtempSync(join(tmpdir(), 'jaren-keys-'));
    writeFileSync(join(root, 'package.json'),
      JSON.stringify({ name: 'fab', version: '1.0.0', workspaces: ['a', 'b'] }));
    for (const name of ['a', 'b']) {
      mkdirSync(join(root, name));
      writeFileSync(join(root, name, 'package.json'),
        JSON.stringify({ name: `@jarenjs/${name}`, version: '1.0.0', description: 'A package.' }));
      writeFileSync(join(root, name, 'site.md'),
        `---\npackage: "@jarenjs/${name}"\ncard:\n  title: The ${name}\n  blurb: It exists.\n`
        + 'engines:\n  - key: shared\n    title: Shared\n---\n\nBody.\n');
    }
    assert.throws(() => buildSiteContent(root), (/** @type {Error} */ error) => {
      // the refusal names the second document AND the first claimant, so
      // the operator does not have to go looking for the other half
      assert.match(error.message, /b\/site\.md: claims the engine key 'shared'/);
      assert.match(error.message, /@jarenjs\/a already claims/);
      return true;
    });
    rmSync(root, { recursive: true, force: true });
  });

  it('never reaches an npm tarball — site presence is a repo concern', function () {
    const workspaces = buildSiteData().packages.map((p) => `--workspace=${p.name}`);
    const packed = JSON.parse(execFileSync('npm',
      ['pack', '--dry-run', '--json', '--ignore-scripts', ...workspaces],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    assert.strictEqual(packed.length, workspaces.length, 'every published workspace is checked');
    for (const tarball of packed) {
      assert.ok(tarball.files.some((/** @type {any} */ f) => f.path === 'README.md'),
        `${tarball.name} still publishes its README`);
      assert.deepStrictEqual(
        tarball.files.filter((/** @type {any} */ f) => f.path === 'site.md'), [],
        `${tarball.name} publishes no site.md — the manifest's files allow-list keeps it out`);
    }
  });
});

describe('a workspace the website has never heard of', function () {
  /**
   * The campaign's definition of done, as a test: a package reaches the
   * site because the root manifest lists it and its own document
   * describes it, so adding one needs NO website edit. The proof runs
   * the real collector over a fabricated repository — a root manifest
   * with one workspace, a manifest and a `site.md` beside it, none of
   * which any line of `packages/website` has ever seen.
   */
  const REPO = join(ROOT, 'test/website/fixtures/zero-edit');

  it('reaches the site with its authored card, its engine and its parsed body', function () {
    const content = buildSiteContent(REPO);
    assert.strictEqual(content.packages.length, 1);
    const [entry] = content.packages;
    assert.strictEqual(entry.name, '@jarenjs/widget');
    assert.strictEqual(entry.derived, false, 'the card is the one the workspace wrote');
    assert.strictEqual(entry.card.title, 'Widget');
    assert.deepStrictEqual(entry.engines.map((/** @type {any} */ e) => [e.key, e.suite]),
      [['widget', 'markdown']]);
    assert.strictEqual(entry.engines[0].card.title, 'Widget',
      'an engine that states only a key and a suite is carded by its package');
    assert.deepStrictEqual(entry.docs.ast.map((/** @type {any} */ n) => n.type),
      ['paragraph', 'code'], 'the body arrives parsed, not as text the site would have to parse');
    assert.strictEqual(entry.docs.meta.sourceUrl, 'packages/widget/site.md');
  });

  it('and the artifact it produces is one the site would accept', function () {
    // the same emit-path gate the real content passes: a fabricated
    // workspace cannot ship a shape the browser's contract refuses
    const text = serializeSiteContent(buildSiteContent(REPO));
    assert.strictEqual(JSON.parse(text).packages[0].name, '@jarenjs/widget');
  });

  it('needs no edit anywhere in packages/website to do it', function () {
    // what a new package would otherwise have had to add: a card in the
    // home document, a section in the docs document, and a row in the
    // card → suite map. None of the three exists any more.
    const source = (file) => readFileSync(join(ROOT, 'packages/website', file), 'utf8');
    assert.ok(!source('src/content/home.js').includes('engines:'),
      'an engine card authored in the website is one a package could not have brought with it');
    assert.ok(!source('src/app/viewmodel.js').includes('HOME_ENGINE_SUITE'),
      'the card → suite map is gone: a package names its own suite in its frontmatter');
    const docs = source('src/content/docs.js');
    for (const moved of ['JSLT stylesheets', 'Schemas as TypeScript', 'Data — documents in SQLite']) {
      assert.ok(!docs.includes(moved),
        `the website still authors the "${moved}" section, which its package owns`);
    }
    assert.deepStrictEqual(DOCS_SECTIONS.map((/** @type {any} */ x) => x.id),
      ['installation', 'draft-support', 'site-contract', 'further-reading'],
      'what the site still authors is what only the site can answer');
  });
});

//#endregion
