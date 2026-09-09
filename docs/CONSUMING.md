# Consuming Jaren

How to depend on the Jaren packages from another project — either as
published npm packages or as a pinned source checkout. If you are *releasing*
Jaren rather than consuming it, see [PUBLISHING.md](workflow/PUBLISHING.md).

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
this repository runs on (`.nvmrc`; the Windows, Ubuntu, packed-consumer and
browser jobs all read it) and it is declared in every package's `engines`,
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
Linux **and** Windows CI. A separate check imports every packed package from
its declared dependency closure under **both Node and Bun**, resolves it
under strict packed TypeScript, and bundles the `@jarenjs/app` closure under
an isolated Vite build — so "it installs and imports cleanly from a registry
tarball" is a tested property, not an assumption.

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
No figure below is typed: `npm run test:tree-shaking` measures the ten
bundles and commits the measurement, and `npm run docs:derive` bakes
every published copy of it — this table, each pen document's Cost
section, and every sentence in one document that quotes another
subpath's price. One number, one bake, so a price cannot be current in
the table and stale in the paragraph that cites it:

| Subpath | Bundle | What rides along |
|---|---:|---|
| `.` | <!--fact:bundle.chain.kb-->174<!--/fact--> kB | the query engine — a chain's document has to run somewhere |
| `./schema` | <!--fact:bundle.schema.kb-->37<!--/fact--> kB | the builders and the recording proxy `check()` captures through |
| `./model` | <!--fact:bundle.model.kb-->45<!--/fact--> kB | the schema pen it subclasses |
| `./jslt` | <!--fact:bundle.jslt.kb-->20<!--/fact--> kB | the body capture; of the schema pen, only the builder brand |
| `./migration` | <!--fact:bundle.migration.kb-->24<!--/fact--> kB | the canonicalizer and hash a shape identity needs |
| `./contract` | <!--fact:bundle.contract.kb-->49<!--/fact--> kB | the schema pen (a contract's inputs and outputs are schemas) |
| `./flow` | <!--fact:bundle.flow.kb-->20<!--/fact--> kB | the capture; of the schema pen, only the brand |
| `./app` | <!--fact:bundle.app.kb-->51<!--/fact--> kB | the schema pen and the JSLT pen (state, and views) |
| `./forms` | <!--fact:bundle.forms.kb-->41<!--/fact--> kB | the schema pen it subclasses |
| `./ai` | <!--fact:bundle.ai.kb-->17<!--/fact--> kB | action programs; no AI runtime |
| `./messages` | <!--fact:bundle.messages.kb-->18<!--/fact--> kB | message templates; no locale packs |
| `./jtlt` | <!--fact:bundle.jtlt.kb-->17<!--/fact--> kB | text template capture; no renderer |
| `./project` | <!--fact:bundle.project.kb-->15<!--/fact--> kB | project files; no Studio engine |
| `./charts` | <!--fact:bundle.charts.kb-->17<!--/fact--> kB | chart definitions; no chart engine |
| `./db` | <!--fact:bundle.db.kb-->626<!--/fact--> kB | the store, the validator and the formats, by construction |

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

`forms`, `view`, `app`, `locales`, `md`, `mermaid`, `calc`, `charts`, `studio`,
`play`, `josl`, `ai`, `flow`, `linq` and `db`
are independent of that set — leave them out unless you use them.

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
this repository are ordinary semver ranges (`@jarenjs/validate` depends on
`@jarenjs/core@^0.22.27`), not the `workspace:` protocol — npm, which this
repository uses, does not understand `workspace:`, so it cannot be adopted
here without breaking publishing. pnpm 9 in turn defaults
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
to the exact 9.15.4 a vendoring consumer runs, on Linux **and Windows** — on
every push: `npm run test:source`, in `scripts/check-source-consumer.js`.
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
