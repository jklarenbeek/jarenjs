#!/usr/bin/env node
//@ts-check
/**
 * What the website knows about the workspaces of this repository: the
 * package census (who is published, at which version, in their own
 * words) and the site content each workspace commits for itself.
 *
 * The workspace manifests are the only place that answer actually lives,
 * and a copy of it kept anywhere else drifts from them. So the site is
 * handed the derivation instead: root `workspaces` in order, each
 * workspace's own `package.json` for the name, version and description,
 * and private workspaces (the website itself, the benchmark harness)
 * left out of a list of PUBLISHED packages.
 *
 * Provenance comes from the HEAD commit, never the clock, so a rebuild
 * of the same revision writes byte-identical output — asserted by the
 * census test, because a generated file that churns per run cannot be
 * diffed and cannot be cached. A checkout without git carries no
 * revision to name and says so with nulls rather than stamping a wall
 * clock that would break that property.
 *
 * Content ownership is inverted: a workspace describes its own site
 * presence in `site.md` beside its manifest — frontmatter for the card
 * and the engine mapping, a markdown body for its documentation section
 * — and this collector validates it, parses it with `@jarenjs/md` and
 * ships the plain-JSON document. A workspace that has not written one
 * yet gets a card derived from its manifest and says so (`derived`), so
 * a half-migrated repository renders honestly instead of dropping the
 * packages that have not moved. A `site.md` that cannot be trusted —
 * malformed frontmatter, a member the grammar does not know, a package
 * name that is not the one beside it, a body the parser cannot read —
 * is a refusal naming the path, never a silently omitted package.
 *
 * Nothing is written that the site could not read: the emit path proves
 * each artifact against the output schema of the operation the browser
 * reads it through — the same compiled document — and refuses rather
 * than shipping a shape a reader would have to discover.
 */

import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parseMarkdown, MdFrontmatterError } from '@jarenjs/md';
import { JarenValidator } from '@jarenjs/validate';

import { headCommit } from './lib/git.js';
import { assertSiteOutput } from './lib/site-contract.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUT = join(ROOT, 'packages/website/public/site/packages.json');
const CONTENT_OUT = join(ROOT, 'packages/website/public/site/content.json');

/** The document a workspace commits to own its presence on the site. */
const SITE_DOC = 'site.md';

/** The frontmatter grammar, as refusals name it. */
const SCHEMA_PATH = 'packages/website/schemas/site-document.schema.json';

/**
 * @typedef {Object} CensusEntry
 * @property {string} name - The published package name.
 * @property {string} dir - Repo-relative workspace directory (the README base).
 * @property {string} version
 * @property {string} description - The manifest's own description.
 */

/**
 * @typedef {Object} SiteCensus
 * @property {string | null} generated - The HEAD commit's date.
 * @property {string | null} commit - The HEAD commit.
 * @property {CensusEntry[]} packages - Public workspaces, in manifest order.
 */

/** The root manifest's workspace directories, repo-relative. */
export function workspaceDirs() {
  const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  return root.workspaces.map((/** @type {string} */ entry) => entry.replace(/^\.\//, ''));
}

/**
 * Build the census document.
 * @returns {SiteCensus}
 */
export function buildSiteData() {
  const { commit, committed } = headCommit();
  /** @type {CensusEntry[]} */
  const packages = [];
  for (const dir of workspaceDirs()) {
    const manifest = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
    if (manifest.private === true) continue;
    packages.push({
      name: manifest.name,
      dir,
      version: manifest.version,
      description: manifest.description ?? '',
    });
  }
  return { generated: committed, commit, packages };
}

/**
 * Serialize the census exactly as the CLI writes it — the emit path, so
 * the contract check cannot be bypassed by a caller that only wanted the
 * bytes.
 * @param {SiteCensus} census
 * @returns {string}
 * @throws {Error} when the census does not match what `site.packages` declares.
 */
export function serializeSiteData(census) {
  assertSiteOutput('site.packages', census, 'packages/website/public/site/packages.json');
  return `${JSON.stringify(census, null, 2)}\n`;
}

/**
 * @typedef {Object} SiteCard
 * @property {string} title
 * @property {string} blurb
 * @property {string | null} perf - Authored voice, never a figure.
 */

/**
 * @typedef {Object} SiteEngine
 * @property {string} key - The id the engine grid and the playground know.
 * @property {string | null} suite - The benchmark suite whose headline measures it.
 */

/**
 * @typedef {Object} ContentEntry
 * @property {string} name - The published package name.
 * @property {SiteCard} card
 * @property {SiteEngine | null} engine
 * @property {any} docs - The plain-JSON MdDocument, or null for a card-only document.
 * @property {boolean} derived - The card came from the manifest, not from a site.md.
 */

/**
 * @typedef {Object} SiteContent
 * @property {string | null} generated - The HEAD commit's date.
 * @property {string | null} commit - The HEAD commit.
 * @property {ContentEntry[]} packages - Public workspaces, in manifest order.
 */

/** @type {((value: unknown) => any) | null} */
let frontmatterValidator = null;

/**
 * The compiled frontmatter grammar, compiled at most once per process.
 * @returns {(value: unknown) => any}
 */
function siteDocumentSchema() {
  if (frontmatterValidator === null) {
    const schema = JSON.parse(readFileSync(join(ROOT, SCHEMA_PATH), 'utf8'));
    frontmatterValidator = new JarenValidator({ skipErrors: false, collectErrors: true })
      .compile(schema);
  }
  return frontmatterValidator;
}

/**
 * A refusal that names the document at fault. The collector aborts on
 * one rather than dropping the package: a workspace whose site document
 * is wrong must be repaired, not quietly rendered from its manifest —
 * that fallback is for workspaces that have not written one at all.
 * @param {string} dir - Repo-relative workspace directory.
 * @param {string} reason
 * @param {string} [detail]
 * @returns {Error}
 */
function refuse(dir, reason, detail = undefined) {
  return new Error(`${dir}/${SITE_DOC}: ${reason}`
    + (detail === undefined ? '' : `\n${detail}`));
}

/**
 * The card a workspace gets before it owns one: its manifest's own
 * words. It is marked `derived`, so the site can say where it came from
 * rather than passing a fallback off as an authored card.
 * @param {any} manifest
 * @returns {SiteCard}
 */
export function derivedCard(manifest) {
  const short = String(manifest.name).replace(/^@jarenjs\//, '');
  return {
    title: short.charAt(0).toUpperCase() + short.slice(1),
    blurb: manifest.description ?? '',
    perf: null,
  };
}

/**
 * One site document, read: parsed, checked against the frontmatter
 * grammar, and cross-checked against the package it claims to describe.
 * Pure — `dir` is only how the refusals name the document.
 * @param {string} dir - Repo-relative workspace directory.
 * @param {string} source - The document's text.
 * @param {string} packageName - The name in the manifest beside it.
 * @returns {ContentEntry}
 * @throws {Error} naming the path, for any document that cannot be trusted.
 */
export function readSiteDocument(dir, source, packageName) {
  let doc;
  try {
    doc = parseMarkdown(source, { sourceUrl: `${dir}/${SITE_DOC}` });
  }
  catch (error) {
    const message = /** @type {Error} */ (error).message;
    throw error instanceof MdFrontmatterError
      ? refuse(dir, 'the frontmatter is malformed', message)
      : refuse(dir, 'the body is not readable as markdown', message);
  }
  const front = doc.frontmatter;
  if (front === null || typeof front !== 'object' || Array.isArray(front)) {
    throw refuse(dir, 'carries no frontmatter object',
      'A site document opens with a frontmatter block (--- for YAML, +++ for TOML)'
      + ` whose members are declared by ${SCHEMA_PATH}.`);
  }
  const result = siteDocumentSchema()(front);
  if (result.valid !== true) {
    throw refuse(dir, `the frontmatter does not match ${SCHEMA_PATH}`,
      result.errors.map((/** @type {any} */ e) =>
        `  ${e.instancePath === '' ? '(root)' : e.instancePath} — ${e.keyword}`
        + `${typeof e.message === 'string' ? `: ${e.message}` : ''}`).join('\n'));
  }
  if (front.package !== packageName) {
    throw refuse(dir, `names package '${front.package}', but the manifest beside it is`
      + ` '${packageName}'`);
  }
  return {
    name: packageName,
    card: { title: front.card.title, blurb: front.card.blurb, perf: front.card.perf ?? null },
    engine: front.engine === undefined
      ? null
      : { key: front.engine.key, suite: front.engine.suite ?? null },
    // a document may be frontmatter only: a package that wants a card
    // and no documentation section says so by writing no body
    docs: doc.ast.length === 0 ? null : doc,
    derived: false,
  };
}

/**
 * One workspace's site content: its own document if it has committed
 * one, its manifest otherwise.
 * @param {string} dir - Repo-relative workspace directory.
 * @param {any} manifest - The manifest beside the document.
 * @returns {ContentEntry}
 * @throws {Error} naming the path, for any document that cannot be trusted.
 */
export function collectSiteDocument(dir, manifest) {
  const path = join(ROOT, dir, SITE_DOC);
  if (!existsSync(path)) {
    return {
      name: manifest.name,
      card: derivedCard(manifest),
      engine: null,
      docs: null,
      derived: true,
    };
  }
  return readSiteDocument(dir, readFileSync(path, 'utf8'), manifest.name);
}

/**
 * Build the site-content document: one entry per public workspace, in
 * manifest order, exactly as the census orders them.
 * @returns {SiteContent}
 */
export function buildSiteContent() {
  const { commit, committed } = headCommit();
  /** @type {ContentEntry[]} */
  const packages = [];
  for (const dir of workspaceDirs()) {
    const manifest = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
    if (manifest.private === true) continue;
    packages.push(collectSiteDocument(dir, manifest));
  }
  return { generated: committed, commit, packages };
}

/**
 * Serialize the site content exactly as the CLI writes it — the emit
 * path, for the same reason the census has one.
 * @param {SiteContent} content
 * @returns {string}
 * @throws {Error} when the content does not match what `site.content` declares.
 */
export function serializeSiteContent(content) {
  assertSiteOutput('site.content', content, 'packages/website/public/site/content.json');
  return `${JSON.stringify(content, null, 2)}\n`;
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let census;
  let censusText;
  let content;
  let contentText;
  try {
    census = buildSiteData();
    censusText = serializeSiteData(census);
    content = buildSiteContent();
    contentText = serializeSiteContent(content);
  }
  catch (error) {
    console.error(/** @type {Error} */ (error).message);
    process.exit(1);
  }
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, censusText);
  writeFileSync(CONTENT_OUT, contentText);
  const authored = content.packages.filter((entry) => !entry.derived).length;
  console.log(`site/packages.json: ${census.packages.length} published workspaces`
    + ` @ ${census.commit === null ? '(no git)' : census.commit.slice(0, 7)}`);
  console.log(`site/content.json: ${authored} workspaces own their site document,`
    + ` ${content.packages.length - authored} derived from their manifest`);
}
