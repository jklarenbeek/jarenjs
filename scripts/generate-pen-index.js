//@ts-check
/**
 * The binder's registry: every cross-pen table in
 * `packages/linq/docs/LINQ-FORMAT.md` is computed here from the eleven
 * documents beside it and written between `<!--fact:pens.key-->` …
 * `<!--/fact-->` markers by `scripts/derive-docs.js`.
 *
 * Why it exists: a normative reference that holds every pen's vocabulary
 * in one place, plus one document per pen, is a two-place edit for every
 * new method — and a two-place edit is a promise nobody keeps. So the
 * binder holds no second copy: the combined tables are the pen
 * documents' own rows, spliced in, and a method added to one document
 * moves here by re-running this script. The rules, the dispositions and
 * what each refusal MEANS stay hand-written above the markers; those are
 * judgement, and no derivation can hold them.
 *
 *   npm run docs:derive          # rewrite the derived text
 *   npm run docs:check           # fail on drift
 *
 * This reads DOCUMENTS and nothing else — never a module, never a
 * bundle, never a benchmark — so it is deterministic and instant on any
 * machine. That is affordable because every fact it copies is already
 * held equal to the code by a gate that does import and does measure:
 * `test/linq/pen-docs.test.js` holds each §2 equal to its subpath's
 * callable names and each §4 equal to the codes its source raises, and
 * `scripts/check-tree-shaking.js` holds each §7 byte count equal to the
 * bundle it builds. Re-deriving any of those here would be a second
 * enumeration of the same truth, which is how two answers to one
 * question get committed.
 *
 * Measured figures are NOT this script's: a subpath's bundle size is
 * baked from `benchmark/bundle-sizes.json` under the `bm:` namespace
 * (`scripts/generate-benchmark-facts.js`), including the §7 headlines
 * this script's `cost` block reads back out of the documents. So the
 * chain of custody for a price is esbuild → the committed baseline → the
 * owning document's §7 → the binder's table, and every hop is a gate.
 *
 * The marker layer is `@jarenjs/md`'s (`bake`) and the baking is
 * `scripts/lib/derive.js`'s — the one namespace and the one runner every
 * derived span in the repository goes through, measured figures included.
 * Markers are HTML comments, so GitHub and the website render the binder
 * with no trace of them.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Where the eleven documents live, relative to the repository root. */
const DOCS_DIR = 'packages/linq/docs';
/** The document that carries the combined view; the rest are its sources. */
const BINDER = 'LINQ-FORMAT.md';

//#region reading the documents

/**
 * The `[start, end)` ranges of fenced code blocks, so a table-shaped line
 * inside a fence is never mistaken for a row.
 * @param {string[]} lines
 */
function fencedLines(lines) {
  const fenced = new Set();
  let open = null;
  lines.forEach((line, i) => {
    const fence = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (open === null) open = fence[1][0];
      else if (fence[1][0] === open) open = null;
      fenced.add(i);
      return;
    }
    if (open !== null) fenced.add(i);
  });
  return fenced;
}

/**
 * One TOP-LEVEL section, its `## N. Title` heading to the next `## `,
 * exclusive. A section that groups its rows under `###` subheadings is
 * one section — a slice that stopped at the first subheading would hand
 * every derivation below the section's preamble and call it the section.
 * @param {string} text @param {string} heading
 */
function sectionOf(text, heading) {
  const start = text.indexOf(heading);
  if (start < 0) return '';
  const from = text.indexOf('\n', start) + 1;
  const next = text.slice(from).search(/^## /m);
  return text.slice(start, next < 0 ? text.length : from + next);
}

/** One `### N.M` subsection, to the next heading of any depth. */
function subsectionOf(text, prefix) {
  const start = text.indexOf(prefix);
  if (start < 0) return '';
  const from = text.indexOf('\n', start) + 1;
  const next = text.slice(from).search(/^#{2,3} /m);
  return text.slice(start, next < 0 ? text.length : from + next);
}

/**
 * The tables of one section, in order, each labelled by the `###`
 * subheading above it with its number dropped — the numbering is that
 * document's, and it means nothing here.
 * @param {string} section
 * @returns {{ label: string, lines: string[] }[]}
 */
function tablesOf(section) {
  const lines = section.split('\n');
  const fenced = fencedLines(lines);
  /** @type {{ label: string, lines: string[] }[]} */
  const tables = [];
  let label = '';
  /** @type {string[] | null} */
  let block = null;
  const close = () => { if (block !== null) tables.push({ label, lines: block }); block = null; };
  lines.forEach((line, i) => {
    if (fenced.has(i)) { close(); return; }
    const subheading = /^#{3,6} +(?:\d+(?:\.\d+)* +)?(.+?)\s*$/.exec(line);
    if (subheading !== null) { close(); label = subheading[1]; return; }
    if (line.startsWith('|')) { (block ??= []).push(line); return; }
    close();
  });
  close();
  return tables;
}

/** A table's data rows: everything but its header and its separator. */
const dataRows = (table) => table.lines.slice(2);

/** What a READER sees: every renderer drops HTML comments, so a figure
 * carried by a marker is read here the way it is read on the page. A
 * derivation that matched the raw source would go blind the moment a
 * figure it reads became derived itself. */
const rendered = (text) => text.replace(/<!--[\s\S]*?-->/g, '');

/**
 * The lead line every document in the directory opens with, under its
 * title and above the RFC 2119 paragraph: what this document writes and
 * when to open it, in the document that owns the answer. The binder's
 * index is that line, per document, and nothing else — which is what
 * makes the index derivable instead of a second copy somebody edits.
 * @param {string} text @param {string} file
 */
function leadOf(text, file) {
  const head = text.slice(0, text.search(/^## /m));
  /** @type {string[]} */
  const quoted = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('>')) quoted.push(line.slice(1).trim());
    else if (quoted.length > 0) break;
  }
  if (quoted.length === 0) {
    throw new Error(`${file} opens with no '> ' lead line under its title — the binder's index `
      + 'is each document\'s own lead, so a document without one cannot be indexed');
  }
  return quoted.join(' ');
}

/**
 * Read one document into everything the derivations ask of it. The
 * sections are found BY TITLE, never by number: the chain keeps its own
 * twelve sections, so its mapping table is §4, its refusals §14 and its
 * cost §17, and the client enumerates a surface where a pen maps a
 * method to the member it emits.
 * @param {string} file @param {string} text
 */
function readDocument(file, text) {
  const headings = [...text.matchAll(/^## (\d+)\. +(.+?)\s*$/gm)]
    .map((m) => ({ number: m[1], title: m[2], heading: m[0] }));
  const titled = (...titles) => {
    for (const title of titles) {
      const found = headings.find((h) => h.title === title);
      if (found !== undefined) return found;
    }
    return undefined;
  };
  const lead = leadOf(text, file);
  const subpath = /`(\.\/[a-z]+|\.)`/.exec(lead);
  const mapping = titled('The mapping table', 'The surface');
  const refusals = titled('Refusals');
  const examples = titled('Worked examples');
  const cost = titled('Cost');
  const costSection = cost === undefined ? '' : rendered(sectionOf(text, cost.heading));
  const bytes = /\*\*([\d,]+) bytes\*\*/.exec(costSection);
  const exampleSection = examples === undefined ? '' : sectionOf(text, examples.heading);
  const fences = [...exampleSection.matchAll(/```(js|json)\n/g)].map((m) => m[1]);
  return {
    file,
    text,
    title: (/^# +(.+?)(?: \(normative\))?\s*$/m.exec(text)?.[1] ?? file),
    lines: text.split('\n').length - 1,
    lead,
    subpath: subpath === null ? null : subpath[1],
    mapping: mapping === undefined ? null
      : { number: mapping.number, tables: tablesOf(sectionOf(text, mapping.heading)) },
    codes: refusals === undefined ? []
      : [...new Set([...sectionOf(text, refusals.heading)
        .matchAll(/^\| `(JL\d{4})` \|/gm)].map((m) => m[1]))],
    examples: fences.filter((lang, i) => lang === 'js' && fences[i + 1] === 'json').length,
    bytes: bytes === null ? null : Number(bytes[1].replace(/,/g, '')),
  };
}

/** @typedef {ReturnType<typeof readDocument>} Document */

/**
 * The directory's documents, in the order a reader meets them: the
 * binder, the chain, then the pens in the order §1.0's disposition table
 * declares them, then whatever the table does not carry — which is how
 * the one document that is NOT a pen lands last without a list here
 * saying so.
 * @param {Map<string, Document>} documents
 */
function readingOrder(documents) {
  const binder = documents.get(BINDER);
  if (binder === undefined) throw new Error(`${BINDER} is not in the directory`);
  const dispositions = subsectionOf(binder.text, '### 1.0');
  const table = tablesOf(dispositions)[0];
  if (table === undefined) {
    throw new Error(`${BINDER} §1.0 carries no disposition table — the reading order is its row order`);
  }
  const declared = dataRows(table)
    .map((row) => [...row.matchAll(/\]\(([A-Za-z0-9._-]+\.md)\)/g)].pop()?.[1])
    .filter((file) => file !== undefined && documents.has(file));
  const chain = [...documents.values()].find((doc) => doc.subpath === '.');
  const order = [BINDER, ...(chain === undefined ? [] : [chain.file]), ...declared];
  const seen = new Set(order);
  return [...order.filter((file, i) => order.indexOf(file) === i),
    ...[...documents.keys()].sort().filter((file) => !seen.has(file))];
}

//#endregion

//#region formatting — one rounding policy, applied everywhere

/** A count with thousand separators, the grouping these documents use. */
const grouped = (n) => n.toLocaleString('en-US');
/** Bytes as the rounded kB `docs/CONSUMING.md` publishes — DECIMAL, the
 * same division `scripts/check-tree-shaking.js` reports, so the rounded
 * column and the exact one beside it are the same number twice. */
const kb = (bytes) => Math.round(bytes / 1000);
/** A cell that carries no answer for this document. */
const NONE = '—';
/** A markdown link to a document in the same directory. */
const link = (file) => `[${file}](${file})`;
/** Prose put in a table cell: an unescaped `|` would end the cell. */
const cell = (text) => text.replace(/\|/g, '\\|');
/** A block body owns whole lines: `\n…\n`, so its markers sit alone. */
const block = (lines) => ['', ...lines, ''].join('\n');

//#endregion

//#region the derivations

/**
 * Every derivation, keyed by the marker that carries it. Each answers
 * with the exact text that replaces its marker's body.
 *
 * @param {Map<string, Document>} documents
 * @returns {Record<string, () => string>}
 */
function derivationsOver(documents) {
  const order = readingOrder(documents);
  /** @type {Document[]} */
  const all = order.map((file) => /** @type {Document} */ (documents.get(file)));
  const penned = all.filter((doc) => doc.mapping !== null);

  return {
    // ——— the index: one row per document, each row the document's own
    // lead line and its own length. A document the directory holds and
    // the index omits is a document no reader of the website can reach
    // (the site walks these files through the binder and only through
    // it), so the row set IS the directory listing.
    'pens.index': () => block([
      '| Document | Lines | What it writes, and when to open it |',
      '|---|---:|---|',
      ...all.map((doc) => `| ${link(doc.file)} | ${grouped(doc.lines)} | ${cell(doc.lead)} |`),
    ]),

    // ——— the census: how much of each pen each document actually
    // carries. Every column is a count over the document itself, and
    // every one of them is held equal to the code elsewhere — the
    // mapping rows by the surface gate, the examples by the docs gate
    // that executes them, the codes by the refusal gate, the bundle by
    // the tree-shaking probe.
    'pens.census': () => block([
      '| Document | Subpath | Lines | Mapping rows | Worked examples | Refusals | Bundle |',
      '|---|---|---:|---:|---:|---:|---:|',
      ...all.map((doc) => {
        const rows = doc.mapping === null ? NONE
          : grouped(doc.mapping.tables.reduce((n, table) => n + dataRows(table).length, 0));
        return `| ${link(doc.file)} | ${doc.subpath === null ? NONE : `\`${doc.subpath}\``} `
          + `| ${grouped(doc.lines)} | ${rows} | ${doc.examples === 0 ? NONE : doc.examples} `
          + `| ${doc.codes.length === 0 ? NONE : doc.codes.length} `
          + `| ${doc.bytes === null ? NONE : `${grouped(doc.bytes)} B`} |`;
      }),
      `| **eleven documents** | | **${grouped(all.reduce((n, doc) => n + doc.lines, 0))}** `
      + `| **${grouped(penned.reduce((n, doc) => n + /** @type {any} */ (doc.mapping).tables
        .reduce((rows, table) => rows + dataRows(table).length, 0), 0))}** `
      + `| **${all.reduce((n, doc) => n + doc.examples, 0)}** | | |`,
    ]),

    // ——— which document owns each shared refusal. What a code MEANS is
    // §1.3's, written by a person; where it is raised is a fact about
    // ten source directories, and each document's own refusal section is
    // held equal to its directory in both directions.
    'pens.codes': () => {
      // §1.3's own subsection, never the whole file: this block is in the
      // same document and carries the same code column, and a mirror read
      // over both would be reading its own output.
      const shared = subsectionOf(/** @type {Document} */ (documents.get(BINDER)).text, '### 1.3');
      const mirror = [...new Set([...shared.matchAll(/^\| `(JL01\d\d)` \|/gm)].map((m) => m[1]))];
      if (mirror.length === 0) throw new Error(`${BINDER} §1.3 carries no JL01xx table to mirror`);
      const orphans = mirror.filter((code) => !all.some((doc) => doc.codes.includes(code)));
      if (orphans.length > 0) {
        throw new Error(`no document lists ${orphans.join(', ')} — a shared code every pen's `
          + 'refusal section omits is a refusal no reader can look up');
      }
      return block([
        '| Code | Raised by |',
        '|---|---|',
        ...mirror.map((code) => `| \`${code}\` | `
          + `${all.filter((doc) => doc.codes.includes(code)).map((doc) => link(doc.file)).join(', ')} |`),
      ]);
    },

    // ——— the measured price of each subpath, as its own document states
    // it. The bytes are the tree-shaking probe's, which fails the build
    // when a document and the bundle it names disagree.
    'pens.cost': () => {
      const priced = all.filter((doc) => doc.bytes !== null);
      if (priced.length === 0) throw new Error('no document states a bundle size in its Cost section');
      return block([
        '| Subpath | Document | Bundle | Rounded |',
        '|---|---|---:|---:|',
        ...priced.map((doc) => `| ${doc.subpath === null ? NONE : `\`@jarenjs/linq${doc.subpath === '.' ? '' : doc.subpath.slice(1)}\``} `
          + `| ${link(doc.file)} | ${grouped(/** @type {number} */ (doc.bytes))} B `
          + `| ${kb(/** @type {number} */ (doc.bytes))} kB |`),
      ]);
    },

    // ——— the combined vocabulary: every mapping table in the suite, in
    // one place, as the rows their own documents carry. This is the
    // whole reason the binder can be a normative reference AND the pen
    // documents can be guides: neither is a copy of the other, because
    // this one is spliced from that one on demand.
    'pens.vocabulary': () => {
      /** @type {string[]} */
      const out = [];
      for (const doc of penned) {
        const mapping = /** @type {any} */ (doc.mapping);
        // the section number rides INSIDE the link text so the citation
        // gate reads it: a `§N` behind a closing paren is invisible to it
        out.push('', `### ${doc.title} — [${doc.file} §${mapping.number}](${doc.file})`);
        // the label once per group, not once per table: a subsection that
        // splits its rows across two tables is one heading in its own
        // document and reads as two here if it is repeated
        let labelled = '';
        for (const table of mapping.tables) {
          if (table.label !== '' && table.label !== labelled) out.push('', `**${table.label}**`);
          labelled = table.label;
          out.push('', ...table.lines);
        }
      }
      return block(out.slice(1));
    },
  };
}

//#endregion

//#region the registry

/** @type {import('./lib/derive.js').Registry} */
export const penTables = {
  name: 'pen documents',
  // the directory listing, never a list: the binder's index IS that
  // listing (a document it omits is one no reader of the website can
  // reach), so a new document has to appear here without an edit
  docs: (root) => readdirSync(join(root, DOCS_DIR))
    .filter((file) => file.endsWith('.md')).sort().map((file) => `${DOCS_DIR}/${file}`),
  facts: (text) => {
    /** @type {Map<string, Document>} */
    const documents = new Map();
    for (const [rel, source] of text) {
      if (!rel.startsWith(`${DOCS_DIR}/`)) continue;
      const file = rel.slice(DOCS_DIR.length + 1);
      documents.set(file, readDocument(file, source));
    }
    return derivationsOver(documents);
  },
};

//#endregion
