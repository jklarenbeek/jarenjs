# Consuming Jaren

How to depend on the Jaren packages from another project — either as
published npm packages or as a pinned source checkout. If you are *releasing*
Jaren rather than consuming it, see [PUBLISHING.md](workflow/PUBLISHING.md).

For an existing application, start with the [public composition and evidence
ledger](ADOPTION-EVIDENCE.md). It maps each retained mechanism to its public owner,
executable installed-consumer recipe, measured limits and remaining qualification.
The documented library composition is ready; real provider, downstream and manual
retirement decisions remain application/operator work.

Two properties shape everything below:

- **There is no build step for source.** Every package's `main` points
  straight at `./src/index.js`. What you check out is what runs.
- **TypeScript declarations are generated, not committed.** `dist/types/` is
  gitignored, so `.d.ts` files exist only after a build or in a packed
  tarball. This is the one thing that surprises source consumers, and it has
  its own section below. Two packages are the exception: `@jarenjs/linq` and
  `@jarenjs/db` hand-author their declarations in a committed `types/`
  directory (their `types` field points at `./types/index.d.ts`), so they
  resolve in a fresh checkout with no build, and a repo test keeps each
  subpath's declared value exports equal to its runtime exports.

Runtime baseline for every package: **Node ≥ 24, ESM only** (`"type":
"module"`), and **zero third-party runtime dependencies** — a `@jarenjs/*`
package depends only on other `@jarenjs/*` packages.

The Node floor is a floor, not a suggestion. It is the line every gate in
this repository runs on (`.nvmrc`; hosted Linux jobs and the optional Windows
qualification both read it) and it is declared in every package's `engines`,
so an install under an older Node prints `EBADENGINE` and is unsupported by
declaration — nothing here is tested on Node 22, and bundling a package into
an application does not change what the package was verified against. A
consumer that must stay on an older line should raise that upstream as a
request for a lower, tested floor rather than install past the warning.

## Mode 1: npm packages (recommended)

```bash
npm install @jarenjs/validate @jarenjs/formats @jarenjs/refs
```

Published tarballs ship `src/`, the declarations (`dist/types/`, or the
committed `types/` for linq and db) and the package docs, so types resolve
with no build on your side. Each release is gated by
`npm run release:check`, which runs lint, the full test suite, all builds, a
TypeScript consumer check, a tree-shaking check and npm pack dry-runs, on
Linux CI. [Windows qualification](workflow/WINDOWS.md) is opt-in and is not
implied by the hosted CI result. A separate check imports every packed package from
its declared dependency closure under **both Node and Bun**, resolves it
under strict packed TypeScript, and bundles the `@jarenjs/app` closure under
an isolated Vite build — so "it installs and imports cleanly from a registry
tarball" is a tested property, not an assumption.

### One version for the whole closure

Every Jaren package is released at one version, together, and every internal
edge names that exact version: `@jarenjs/validate` depends on `@jarenjs/core`
at the suite version itself, not a range. So pin each direct `@jarenjs/*`
dependency to the same exact version (no `^`) and the whole closure follows —
npm installs one copy of each package, all from one release, with no
`overrides` block.

- A direct pin that disagrees with the others (`@jarenjs/app` from one
  release, `@jarenjs/core` from another) shows up as a second, nested copy of
  the shared packages (`node_modules/@jarenjs/app/node_modules/@jarenjs/core`)
  instead of a silently mixed closure. `npm ls @jarenjs/core` lists every
  copy; a healthy tree has one.
- Taking one package's patch alone is not possible — upgrade the suite
  together, which the lockstep release already required.

Up to 0.92.0 the internal edges were caret ranges, so pinning
`@jarenjs/app` could still resolve its siblings from a later release, each
with its own nested `@jarenjs/core`; an `overrides` block was the only way to
hold the closure together. With exact edges it is not needed.

## Mode 2: pinned source (git submodule or vendored checkout)

Consume the repository directly when you want a reviewed, reproducible pin
rather than a registry version — a common choice while Jaren is pre-1.0.

```bash
git submodule add https://github.com/jklarenbeek/jarenjs.git vendor/jarenjs
git -C vendor/jarenjs checkout <the tag you reviewed>   # e.g. v0.22.27
```

Pin the **resolved commit**, not the tag. Release tags here are lightweight,
so a tag is a pointer its owner can move; the gitlink your submodule records
is the thing that cannot change under you. `git -C vendor/jarenjs rev-parse
HEAD` after checkout, and review that SHA rather than the tag name.

**Do not use `--recursive`.** This repository's own submodules are external
conformance and benchmark corpora — the JSON-Schema-Test-Suite, the JSONPath
compliance suite, W3C qt3tests, toml-test and the CommonMark spec. They are
needed only to reproduce the upstream test gate and are irrelevant to
consuming the packages. A plain `git submodule update --init vendor/jarenjs`
in your CI checkout is what you want; `--recursive` pulls hundreds of
megabytes of fixtures you will never run.

### Pick the packages you actually need

The dependency arrow is one-way and cycle-free, so a subset is always
coherent. For server-side or browser **validation only**, these packages
suffice — the first three are required, the rest only when their row says so:

| Package | Needed for |
|---|---|
| `@jarenjs/core` | Foundation. Zero dependencies — everything sits on it |
| `@jarenjs/json` | Pointer/path addressing; required by `validate` |
| `@jarenjs/validate` | The validating compiler |
| `@jarenjs/formats` | Only if you use the `format` keyword |
| `@jarenjs/refs` | Only if you `$ref` the official meta-schemas offline |
| `@jarenjs/emit` | Only if you generate TypeScript from your schemas |
| `@jarenjs/contract` | Only if two ends exchange operations over a wire. Closure: `core`, `json`, `validate` — plus `emit`, reached only from its `./project` subpath (projections), so a bundle that never projects never carries it. Ships the `jaren-contract` CLI (projections, `--check`, `diff --fail-on breaking`); every document flag takes a `.json` file or a pure module (`.js`/`.mjs`/`.cjs`/`.ts`) whose `default` or `contract` export is the document or a `@jarenjs/linq/contract` pen, loaded through `@jarenjs/json/node` — the Node-only subpath of `json`, shared with `jaren-db` |

Which contract subpath needs what: `.` and every binding and runtime
subpath — `./http`, `./fetch`, `./node`, `./client`, `./app`, `./local`,
`./port`, `./stream`, `./ledger`, `./diff` — need only `core` + `json` +
`validate`; `./project` (the OpenAPI/TypeScript/Markdown/tools
projections) and the `jaren-contract` CLI additionally need `emit`. The
tree-shaking gate holds this: a bundle that never imports `./project`
carries no emit code.

The CI recipe for a code-first contract: keep the contract as a module
(`contract.js` exporting the pen's `defineContract(…)`), commit the
projected declaration beside it, and let the drift gate run against the
module directly — `jaren-contract types --contract contract.js --out
src/shop.d.ts --check` exits 1 when the declaration is missing or stale
and 0 when it is current; the module is evaluated twice and refused when
its two emissions differ (a clock, the environment, randomness in it).

Which linq subpath needs what: `.` (the chain) and every pen —
`./schema`, `./model`, `./jslt`, `./migration`, `./contract`, `./flow`,
`./app`, `./forms` — need only `core` + `json`, and no pen imports the
package it writes for (the contract pen carries no byte of
`@jarenjs/contract`, the app pen none of `@jarenjs/app`, and so on).
`./db`, the store's typed front door, is the package's ONE runtime edge:
it additionally needs `@jarenjs/db`, `@jarenjs/validate` and
`@jarenjs/formats`, which `@jarenjs/linq` declares as OPTIONAL peer
dependencies. So `npm install @jarenjs/linq` alone installs nothing
beyond `core` and `json`, and a `./db` consumer installs the three
itself (`npm install @jarenjs/db @jarenjs/validate @jarenjs/formats`;
pnpm's isolated layout resolves declared peers the same way).

The prices are published rather than hidden — one minified, tree-shaken
bundle per subpath (esbuild, `platform: 'neutral'`, `node:*` external).
No figure below is typed: `npm run test:tree-shaking` measures every
bundle in the table and commits the measurement, and `npm run docs:derive` bakes
every published copy of it — this table, each pen document's Cost
section, and every sentence in one document that quotes another
subpath's price. One number, one bake, so a price cannot be current in
the table and stale in the paragraph that cites it:

| Subpath | Bundle | What rides along |
|---|---:|---|
| `.` | <!--fact:bundle.chain.kb-->251<!--/fact--> kB | the query engine — a chain's document has to run somewhere |
| `./schema` | <!--fact:bundle.schema.kb-->48<!--/fact--> kB | the builders and the recording proxy `check()` captures through |
| `./model` | <!--fact:bundle.model.kb-->60<!--/fact--> kB | the schema pen it subclasses |
| `./jslt` | <!--fact:bundle.jslt.kb-->29<!--/fact--> kB | the body capture; of the schema pen, only the builder brand |
| `./migration` | <!--fact:bundle.migration.kb-->36<!--/fact--> kB | the canonicalizer and hash a shape identity needs |
| `./contract` | <!--fact:bundle.contract.kb-->61<!--/fact--> kB | the schema pen (a contract's inputs and outputs are schemas) |
| `./flow` | <!--fact:bundle.flow.kb-->30<!--/fact--> kB | the capture; of the schema pen, only the brand |
| `./app` | <!--fact:bundle.app.kb-->63<!--/fact--> kB | the schema pen and the JSLT pen (state, and views) |
| `./forms` | <!--fact:bundle.forms.kb-->52<!--/fact--> kB | the schema pen it subclasses |
| `./formula` | <!--fact:bundle.formula.kb-->14<!--/fact--> kB | saved Query profiles; no evaluator |
| `./messages` | <!--fact:bundle.messages.kb-->15<!--/fact--> kB | message templates; no locale packs |
| `./jtlt` | <!--fact:bundle.jtlt.kb-->26<!--/fact--> kB | text template capture; no renderer |
| `./project` | <!--fact:bundle.project.kb-->5<!--/fact--> kB | project files; no Studio engine |
| `./charts` | <!--fact:bundle.charts.kb-->7<!--/fact--> kB | chart definitions; no chart engine |
| `./db` | <!--fact:bundle.db.kb-->1137<!--/fact--> kB | the store, the validator and the formats, by construction |

Read the last row as the honest one: the front door costs what the store
costs, because it *is* the store. The tree-shaking gate holds both
halves of the edge rule — the `.` entry carries not one byte of the
three peers, and no pen carries another pen's modules or an engine.

The remaining packages are independent of the validation set above in
the only sense that matters when you are picking packages: none of them
is *needed* to validate. Independent does not mean closure-free — every
one still brings its own arrows, and several of those point back into
the set (the store and the form model both sit on the validating
compiler; the chain sits on the addressing package). The graph in
[ARCHITECTURE.md](ARCHITECTURE.md#monorepo-layout) is the authority on
which.

`forms`, `view`, `app`, `locales`, `md`, `mermaid`, `calc`, `charts`, `collection`, `rules`, `studio`,
`play`, `josl`, `flow`, `linq` and `db`
are independent of that set — leave them out unless you use them.

### What a Node server loads

A bundler drops the modules you never reach; Node does not. Importing a
subpath in Node loads every module its import statements reach, used or
not, and holds them for the life of the process, so on a server a
subpath costs its whole static import graph rather than the tree-shaken
bundle above (a server bundled with `@jarenjs/*` inside pays the bundle
price instead; see [Docker and bundling](#docker-and-bundling)). The
tables below give that cost for every subpath the manifests of
`contract`, `db`, `linq`, `json`, `validate` and `core` name: the modules
a fresh Node process loads for that one `import`, split by the package
that owns each file (a JSON module counts, a `node:` built-in does not),
and the live heap they hold — the V8 heap after two forced full
collections, run on the main thread so each has finished when the heap
is read, less the same process's heap before the import. Each heap is
the median of <!--fact:closure.runs-->5<!--/fact--> fresh processes, whose runs differed by at
most <!--fact:closure.spread-->67 KiB<!--/fact--> for any one subpath; native memory a built-in
allocates for itself (`node:crypto`'s, say) is not in it. A heap depends
on the runtime and the host — these were measured on one machine,
with <!--fact:closure.host-->Node v24.22.1 on linux x64<!--/fact--> — while a module count is
exact: `npm run test:tree-shaking` fails when one differs from the
tree's. The heaps are re-measured for every release
(`npm run test:tree-shaking -- --write`), and
[`benchmark/node-closures.json`](../benchmark/node-closures.json) holds
the same figures for all <!--fact:closure.subpaths-->271<!--/fact--> importable subpaths of
every package, each file of a wildcard export (`@jarenjs/core/dates/*`)
included.

**`@jarenjs/contract`**

<!--fact:closure.contract-->
| Subpath | Modules | By package | Live heap MiB |
|---|---:|---|---:|
| `.` | 140 | core 73, validate 29, json 26, contract 12 | 6.1 |
| `./app` | 29 | core 11, contract 9, json 9 | 1.4 |
| `./auth-node` | 11 | core 8, contract 3 | 1.3 |
| `./client` | 141 | core 75, validate 27, json 26, contract 13 | 6.0 |
| `./command` | 23 | core 11, json 7, contract 5 | 1.2 |
| `./continuation-node` | 20 | core 10, json 7, contract 3 | 1.6 |
| `./diff` | 140 | core 73, validate 29, json 26, contract 12 | 6.4 |
| `./fetch` | 11 | core 8, contract 3 | 0.7 |
| `./http` | 46 | contract 17, core 16, json 7, validate 6 | 2.0 |
| `./ledger` | 11 | core 9, contract 2 | 0.8 |
| `./local` | 19 | core 10, contract 9 | 1.0 |
| `./node` | 13 | core 9, contract 4 | 0.7 |
| `./port` | 27 | contract 15, core 12 | 1.3 |
| `./project` | 172 | core 83, json 41, validate 29, contract 14, emit 5 | 8.9 |
| `./provider` | 113 | core 74, json 31, contract 8 | 4.3 |
| `./stream` | 16 | core 11, contract 5 | 1.0 |
| `./webmcp` | 1 | contract 1 | 0.1 |
<!--/fact-->

**`@jarenjs/db`**

<!--fact:closure.db-->
| Subpath | Modules | By package | Live heap MiB |
|---|---:|---|---:|
| `.` | 195 | db 80, core 76, json 33, validate 6 | 11.0 |
| `./app` | 1 | db 1 | 0.1 |
| `./async-live` | 136 | core 63, db 46, json 21, validate 6 | 7.5 |
| `./bun` | 128 | core 62, db 39, json 21, validate 6 | 6.1 |
| `./entity` | 132 | core 63, db 40, json 23, validate 6 | 7.0 |
| `./model` | 119 | core 62, db 30, json 21, validate 6 | 5.8 |
| `./node` | 129 | core 62, db 40, json 21, validate 6 | 6.5 |
| `./node-pool` | 105 | core 61, db 23, json 21 | 4.7 |
| `./node-process` | 101 | core 61, json 21, db 19 | 4.7 |
| `./node-worker` | 101 | core 61, json 21, db 19 | 4.7 |
| `./postgres` | 119 | core 62, db 36, json 21 | 5.0 |
| `./query` | 132 | core 62, db 43, json 21, validate 6 | 7.4 |
| `./relational` | 122 | core 62, db 33, json 21, validate 6 | 5.9 |
| `./search` | 92 | core 66, json 21, db 5 | 4.1 |
| `./typed` | 1 | db 1 | 0.1 |
| `./wasm` | 103 | core 61, db 21, json 21 | 4.7 |
| `./worker-endpoint` | 133 | core 62, db 44, json 21, validate 6 | 6.7 |
<!--/fact-->

**`@jarenjs/linq`**

<!--fact:closure.linq-->
| Subpath | Modules | By package | Live heap MiB |
|---|---:|---|---:|
| `.` | 93 | core 61, json 21, linq 11 | 4.3 |
| `./app` | 24 | linq 16, core 8 | 1.2 |
| `./authoring` | 15 | core 8, linq 7 | 0.9 |
| `./charts` | 15 | core 8, linq 7 | 1.0 |
| `./contract` | 20 | core 10, linq 10 | 1.1 |
| `./db` | 267 | core 89, db 80, json 36, validate 28, linq 27, formats 7 | 13.5 |
| `./flow` | 19 | linq 11, core 8 | 1.0 |
| `./forms` | 21 | linq 13, core 8 | 1.2 |
| `./formula` | 90 | core 61, json 24, linq 5 | 4.0 |
| `./jslt` | 17 | linq 9, core 8 | 1.0 |
| `./jtlt` | 15 | core 8, linq 7 | 0.9 |
| `./messages` | 16 | core 9, linq 7 | 1.0 |
| `./migration` | 27 | core 11, linq 9, json 7 | 1.3 |
| `./model` | 23 | linq 15, core 8 | 1.3 |
| `./project` | 14 | core 8, linq 6 | 0.9 |
| `./schema` | 19 | linq 11, core 8 | 1.1 |
<!--/fact-->

**`@jarenjs/json`**

<!--fact:closure.json-->
| Subpath | Modules | By package | Live heap MiB |
|---|---:|---|---:|
| `.` | 87 | core 61, json 26 | 3.8 |
| `./basic` | 3 | json 2, core 1 | 0.2 |
| `./canonical` | 17 | core 10, json 7 | 0.8 |
| `./formula` | 85 | core 61, json 24 | 3.7 |
| `./formula/batch` | 86 | core 61, json 25 | 3.7 |
| `./formula/migrate` | 88 | core 61, json 27 | 4.1 |
| `./jslt` | 103 | core 72, json 31 | 4.1 |
| `./jtlt` | 108 | core 72, json 36 | 4.1 |
| `./node` | 18 | core 10, json 8 | 1.3 |
| `./patch` | 18 | core 10, json 8 | 0.9 |
| `./path` | 18 | core 11, json 7 | 0.9 |
| `./pointer` | 16 | core 10, json 6 | 0.8 |
| `./query` | 82 | core 61, json 21 | 3.6 |
| `./rules` | 87 | core 61, json 26 | 3.8 |
| `./write` | 20 | core 11, json 9 | 1.0 |
| `./xquery` | 84 | core 61, json 23 | 3.9 |
<!--/fact-->

**`@jarenjs/validate`**

<!--fact:closure.validate-->
| Subpath | Modules | By package | Live heap MiB |
|---|---:|---|---:|
| `.` | 125 | core 72, validate 27, json 26 | 5.3 |
| `./load` | 100 | core 63, json 26, validate 11 | 4.4 |
| `./normalize` | 127 | core 72, validate 29, json 26 | 5.6 |
| `./output` | 100 | core 63, json 26, validate 11 | 4.4 |
| `./query` | 125 | core 72, validate 27, json 26 | 5.3 |
| `./references` | 24 | core 12, json 6, validate 6 | 1.0 |
| `./strict-profile` | 128 | core 72, validate 30, json 26 | 5.7 |
<!--/fact-->

**`@jarenjs/core`**

<!--fact:closure.core-->
| Subpath | Modules | By package | Live heap MiB |
|---|---:|---|---:|
| `.` | 5 | core 5 | 0.3 |
| `./array` | 6 | core 6 | 0.3 |
| `./async` | 6 | core 6 | 0.3 |
| `./bigint` | 6 | core 6 | 0.3 |
| `./cache` | 9 | core 9 | 0.6 |
| `./check` | 5 | core 5 | 0.3 |
| `./checksum` | 1 | core 1 | 0.1 |
| `./chunk` | 1 | core 1 | 0.1 |
| `./color` | 1 | core 1 | 0.1 |
| `./convert` | 5 | core 5 | 0.2 |
| `./dates` | 13 | core 13 | 0.6 |
| `./errors` | 1 | core 1 | 0.1 |
| `./finance` | 10 | core 10 | 0.3 |
| `./float` | 6 | core 6 | 0.3 |
| `./function` | 5 | core 5 | 0.3 |
| `./geo` | 22 | core 22 | 0.8 |
| `./guarded` | 5 | core 5 | 0.3 |
| `./integer` | 6 | core 6 | 0.3 |
| `./math` | 12 | core 12 | 0.5 |
| `./message` | 9 | core 9 | 0.5 |
| `./model` | 9 | core 9 | 0.5 |
| `./number` | 1 | core 1 | 0.1 |
| `./object` | 8 | core 8 | 0.5 |
| `./process-node` | 1 | core 1 | 0.7 |
| `./random` | 1 | core 1 | 0.1 |
| `./range` | 10 | core 10 | 0.6 |
| `./retry` | 9 | core 9 | 0.5 |
| `./route` | 10 | core 10 | 0.6 |
| `./runtime` | 1 | core 1 | 0.1 |
| `./scan` | 1 | core 1 | 0.1 |
| `./schedule` | 10 | core 10 | 0.6 |
| `./schema` | 9 | core 9 | 0.6 |
| `./search` | 12 | core 12 | 0.6 |
| `./series` | 18 | core 18 | 0.7 |
| `./stats` | 2 | core 2 | 0.1 |
| `./string` | 6 | core 6 | 0.3 |
| `./text` | 17 | core 17 | 0.6 |
| `./vector` | 1 | core 1 | 0.1 |
| `./virtual` | 1 | core 1 | 0.1 |
<!--/fact-->

### Wire the packages into your workspace

The packages resolve each other by name (`@jarenjs/validate` imports
`@jarenjs/core`), so your package manager has to know where those names live.
Either include them in your workspace globs:

```yaml
# pnpm-workspace.yaml
packages:
  - 'apps/*'
  - 'packages/*'
  - 'vendor/jarenjs/packages/core'
  - 'vendor/jarenjs/packages/json'
  - 'vendor/jarenjs/packages/validate'
  - 'vendor/jarenjs/packages/formats'
  - 'vendor/jarenjs/packages/refs'
  - 'vendor/jarenjs/packages/emit'
```

**On pnpm 9, workspace globs alone are not enough.** The internal edges in
this repository are exact versions (`@jarenjs/validate` depends on
`@jarenjs/core` at exactly the suite version), not the `workspace:` protocol —
npm, which this repository uses, does not understand `workspace:`, so it
cannot be adopted here without breaking publishing. pnpm 9 in turn defaults
`link-workspace-packages` to **false**. The combination means a transitive
`@jarenjs/core` can be satisfied from the registry even though you vendored
it, producing a build that silently mixes vendored and published code. Turn
linking on and pin the edges explicitly:

```ini
# .npmrc
link-workspace-packages=true
prefer-workspace-packages=true
```

```jsonc
// package.json — one entry per Jaren package you vendor
{ "pnpm": { "overrides": {
  "@jarenjs/core":     "link:./vendor/jarenjs/packages/core",
  "@jarenjs/json":     "link:./vendor/jarenjs/packages/json",
  "@jarenjs/validate": "link:./vendor/jarenjs/packages/validate",
  "@jarenjs/formats":  "link:./vendor/jarenjs/packages/formats",
  "@jarenjs/refs":     "link:./vendor/jarenjs/packages/refs",
  "@jarenjs/emit":     "link:./vendor/jarenjs/packages/emit"
} } }
```

### Prove it, do not assume it

Configuration expresses intent; only the resolved path settles where the code
came from. Whatever route you take, assert it in CI — walk the whole
`@jarenjs/*` closure and reject anything whose realpath falls outside your
vendor directory:

```js
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL#pathname: a pathname is `/C:/repo/...` on Windows,
// which is not a native filesystem path.
const VENDOR = realpathSync(fileURLToPath(new URL('./vendor/jarenjs/', import.meta.url)));

// Containment is path arithmetic, never a string prefix: native Windows
// realpaths carry drive letters and backslashes, and a prefix check also
// accepts `/repo-other` as inside `/repo`.
const isWithin = (root, candidate) => {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
};

const queue = [['@jarenjs/validate', import.meta.url]];
const seen = new Set();
while (queue.length > 0) {
  const [name, from] = queue.pop();
  if (seen.has(name)) continue;
  seen.add(name);
  // Resolve each edge FROM ITS PARENT: a transitive dependency is not
  // hoisted to your root under pnpm's isolated layout.
  const manifest = realpathSync(createRequire(from).resolve(`${name}/package.json`));
  if (!isWithin(VENDOR, manifest))
    throw new Error(`${name} resolved outside the vendored source: ${manifest}`);
  for (const dep of Object.keys(createRequire(manifest)(manifest).dependencies ?? {}))
    if (dep.startsWith('@jarenjs/')) queue.push([dep, manifest]);
}
```

This repository runs exactly that check against a real pnpm consumer — pinned
to the exact 9.15.4 a vendoring consumer runs, on Linux on every push:
`npm run test:source`, in `scripts/check-source-consumer.js`. The same fixture
is retained in the [optional Windows workflow](workflow/WINDOWS.md).
Worth knowing what actually makes it pass: once you run the install **inside**
the submodule, npm's own workspace symlinks in `vendor/jarenjs/node_modules`
satisfy the internal edges, and they win before any consumer-side setting
applies. That is why "generate the declarations first" below is not only
about types — skip the install in the submodule and the edges have nowhere
local to resolve to.

...or build stable local artifacts once and depend on those:

```bash
npm --prefix vendor/jarenjs run build
npm pack --pack-destination ./vendor/tarballs \
  --workspace=@jarenjs/core --workspace=@jarenjs/json \
  --workspace=@jarenjs/validate --workspace=@jarenjs/formats \
  --workspace=@jarenjs/refs --workspace=@jarenjs/emit
```

The tarball route costs an extra step per upgrade but gives you exactly what
npm consumers get, declarations included — worth it if your build treats
workspace symlinks differently from installed packages.

### Generate the TypeScript declarations first

This is the step that bites. `package.json` `types` and `exports` point at
`./dist/types/*.d.ts`, which **does not exist in a fresh checkout** (linq
and db excepted — theirs are committed under `types/`):

```bash
npm --prefix vendor/jarenjs install
npm --prefix vendor/jarenjs run build      # all workspaces
# or, per package:
npm --prefix vendor/jarenjs run build:types --workspace=@jarenjs/validate
```

`build:types` runs `tsc -p tsconfig.json` to emit declarations from the
JSDoc; it is also wired to `prepack`, which is why packed tarballs already
contain them. Run it **before** your typecheck and before any bundling step,
or TypeScript resolves the packages as untyped and every import silently
becomes `any`.

The declarations use explicit resource management — `@jarenjs/db`'s
synchronous cursors declare `[Symbol.dispose]()` — so a project that checks
them (`skipLibCheck: false`) compiles with `ESNext`, or `ESNext.Disposable`
beside its own target's library, in `lib`; with only `ES2022`–`ES2025` there
TypeScript refuses the declaration (TS2550). `@types/node` references
`esnext.disposable` itself, so a project that has it in scope is covered
already. The suite's own consumer check compiles with `lib: ["ESNext", "DOM"]`
and `skipLibCheck: false`.

## Docker and bundling

Three failure modes account for nearly every broken production image:

1. **The vendor directory is missing from the dependency stage.** If your
   Dockerfile copies `package.json` and lockfiles before `npm ci`, it must
   copy `vendor/` too — the workspace entries reference paths that have to
   exist at install time.
2. **Submodules are not initialized in CI.** `actions/checkout` does not
   fetch submodules by default. Set `submodules: true` (not `recursive`).
3. **Bundler externals leave dangling symlinks.** A server build that marks
   everything outside your own scope as external will emit imports of
   `@jarenjs/*` that resolve, in the image, to workspace symlinks that were
   never copied. Either bundle `@jarenjs/*` into the server output — they are
   ESM and side-effect-free, so they tree-shake and bundle cleanly — or copy
   the complete resolved dependency closure into the runtime stage.

For browsers there is nothing special to configure: the compilers use no
`eval` and no `new Function`, so they run under a strict Content Security
Policy, and `sideEffects: false` lets bundlers drop what you do not import.

## Upgrading a pin

All public workspaces share one version, so an upgrade is a single gitlink
move. Treat it as a reviewed change:

```bash
git -C vendor/jarenjs fetch --tags origin
git -C vendor/jarenjs checkout <reviewed-tag>
git diff --submodule=log -- vendor/jarenjs   # read what actually moved
```

Then re-run your own test suite together with the upstream gate
(`npm --prefix vendor/jarenjs run release:check`) before committing the
gitlink. Jaren is pre-1.0: patch releases do not break public API, but minor
releases may. Pinning to a reviewed tag and reading the gitlink diff is the
control that makes that acceptable.


## Adopting an existing SQLite file

Author a model through `@jarenjs/linq/model` with `.physical({ table, columns })`,
then call `open` from `@jarenjs/linq/db` with a public `nodeDriver()` or
`bunDriver()`, the file path and `adopt: true`. The explicit codecs define the
JSON boundary and the existing file is verified without DDL. The portable
installed-package probe in `test/consumer/relational.js` demonstrates settings,
integer receipts, preserved history triggers and mixed entity/outbox rollback.

Prepared application SQL belongs to `client.transaction(tx => ...)` through
`tx.sql`; it shares the store's connection, authority and lifetime. Schema changes
remain explicit: use `planPhysicalMigration`/`migrate` for preservation programs,
or the synchronous [native SQLite planners](../packages/db/docs/SQLITE-RELATIONAL.md)
for guarded rebuilds and narrow additive/object operations. Follow the
[model pen](../packages/linq/docs/MODEL-PEN.md#existing-column-layouts-and-persistence-rules),
[transaction recipe](../packages/linq/docs/DB-CLIENT.md#trusted-sql-during-adoption),
and [recovery contract](../packages/db/docs/MIGRATION-FORMAT.md#existing-physical-files-and-forward-recovery).

A transaction that meets contention is retried by asking for it:
`client.transaction(fn, { retry: { attempts: 3 } })` runs the whole body
again, on a fresh unit of work, and only after a failure that says a retry
is safe. A loop written around `transaction` instead re-saves whatever a
failed attempt left pending in a shared unit of work. `holdTimeoutMs`, at
open or per call, rolls back a body that holds the connection too long and
hands the connection on (`JD2098`). Both are defined in
[MODEL-FORMAT §5.1](../packages/db/docs/MODEL-FORMAT.md#51-transaction-ownership),
and the store's README runs them end to end.

### Native column plans and bounded ranges

Installed `@jarenjs/db` exports execute the [native SQL census](../packages/db/docs/NATIVE-PLANS.md). `@jarenjs/linq/db` exports `createDbRangeProvider` and entity handles expose `range`. The [provider contract](../packages/app/docs/COLLECTION-PROVIDER.md) distinguishes source epochs from client generations, resident index seeks from sequential continuations, and complete totals from loaded rows. The packed consumer runs the retained SQL comparison and no-op mutations under Node and Bun.

Virtual collection consumers import geometry from `@jarenjs/core/virtual`, the headless controller from `@jarenjs/collection`, and DOM widgets from `@jarenjs/collection/component`. The host injects `createCollectionCoordinator` and a structural array or linq/db provider; [the contract](../components/collection/docs/COLLECTION.md) keeps these owners separate.

For drag interactions, compose `createDragInteraction` with
`mountCollectionDrag`, or use `createDraggableCollectionWidget` for one owned
widget. Render dedicated handles and inject stable identity, permission and
command callbacks. The [drag contract](../components/collection/docs/COLLECTION.md#owned-collection-drag-adapter)
defines keyboard/touch activation, finite resources and complete disposal.

Node consumers needing caller deadlines during native SQLite work can import
`nodeProcessDriver` from `@jarenjs/db/node-process`. Use its ordinary Driver with
`openStore`, retain the opened owner for `supervise`, and await confirmed exit
before replacement. The [host contract](../packages/db/docs/HOSTS.md#supervised-node-processes)
separates response cancellation from owner and receipt settlement.

Lexical consumers import `compileLexical` from `@jarenjs/core/search`; the packed
consumer exercises both frozen corpora without installing MiniSearch. Optional
`createLexicalProvider` from `@jarenjs/json/query` evaluates filters and facets over
complete membership; LINQ emits the same `$lexical` request. Hosts can compose
`@jarenjs/db/search` persistence, `@jarenjs/linq/db` credited lexical ranges and
`@jarenjs/app/search` injected workers independently. See the [core contract](../packages/core/docs/SEARCH.md),
[db adapter](../packages/db/docs/SEARCH.md) and [worker lifecycle](../packages/app/docs/SEARCH.md).
The retained-reference cold profile is qualified for synthetic Node/Bun consumers;
actual downstream cutover and native full-text dialect parity remain separate work.

### Provider execution and complete ingestion

Compose `@jarenjs/contract/provider` (`compileProvider`, `createProviderExecutor`,
`withProviderRun`), `@jarenjs/flow` (`createIngestion`) and `@jarenjs/linq/db`
(`createDbIngestionStore`) through their public structural capabilities. Install
the corresponding packages and the linq database adapter's declared peers.
Applications declare provider dialects, source snapshot/revision evidence,
staging collections, reconciliation and current destination authority. Secrets
remain in the host transport. A source generation publishes only after every
requested partition completes; identical input is a zero-write replay.

The packed-consumer gate installs this composition independently of each
package's own dependency-closure proof. It executes synthetic REST, GraphQL and
archive-link transcripts and two bounded ingestion consumers on Node and Bun.
See the [provider contract](../packages/contract/docs/PROVIDER-FORMAT.md) for
refusals and qualification limits. Real provider writes still need separate
qualification; durable commands and reconciliation are described below.

## Durable commands and existing runs

The installed composition consumer in `test/consumer/durable.js` uses
`@jarenjs/contract/command`, `@jarenjs/linq/db`, `@jarenjs/flow` and `@jarenjs/app`
with an application model. `npm run test:packed` executes it from packed Node and
Bun installations alongside the independent per-package closure checks. It
covers permanent replay after expiry, authorization, interrupted multi-leg
operations, fenced reconciliation and bounded run observation. The reference
cost comparison is `npm run benchmark:durable`. See the
[crash and authorization matrix](../packages/contract/docs/DURABLE.md).

Hosts still provide business schemas, public summary projections, current
permissions, provider guarantees and actor/reason decisions. Single-send outcomes
remain unresolved until evidence settles them. Synthetic installed-consumer
qualification does not establish real provider behavior, downstream cutover,
operator reconciliation acceptance, or capabilities outside that fixture.
Build-selected managed SQLite/PostgreSQL executables have a separate
[public application and recovery qualification](../packages/db/docs/POSTGRESQL.md).

## Saved formula and rule composition

For the full application composition, see [portable replacement evidence](ADOPTION-EVIDENCE.md)
and the website's `#/collection?mode=adoption` journey. It uses one adopted SQLite
file and its existing jobs, public query/search and collection APIs, reviewed
formula writes, complete provider ingestion and recoverable external intent.
The packed and standalone gates execute the same anonymous application policies.
Adopted queue reuse creates no infrastructure; provision or migrate that queue
explicitly before opening with `adopt: true, jobs: true`.

Install `@jarenjs/json`, `@jarenjs/linq` and `@jarenjs/rules` for formula documents and authoring UI. Inject `createTypeTestCompiler` from `@jarenjs/validate/query` when schemas are declared. Reviewed writes additionally compose `@jarenjs/contract/command` with `createDbReceipts` from `@jarenjs/linq/db`; choose an installed Node/Bun/browser driver explicitly. The preview is never write authority. See [FORMULA-FORMAT](../packages/json/docs/FORMULA-FORMAT.md) and the [rules component](../components/rules/README.md). Portable tarball qualification exercises both frozen workloads and zero-write replay.
