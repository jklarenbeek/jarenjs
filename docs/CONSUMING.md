# Consuming Jaren

How to depend on the Jaren packages from another project — either as
published npm packages or as a pinned source checkout. If you are *releasing*
Jaren rather than consuming it, see [PUBLISHING.md](PUBLISHING.md).

Two properties shape everything below:

- **There is no build step for source.** Every package's `main` points
  straight at `./src/index.js`. What you check out is what runs.
- **TypeScript declarations are generated, not committed.** `dist/types/` is
  gitignored, so `.d.ts` files exist only after a build or in a packed
  tarball. This is the one thing that surprises source consumers, and it has
  its own section below.

Runtime baseline for every package: **Node ≥ 22, ESM only** (`"type":
"module"`), and **zero third-party runtime dependencies** — a `@jarenjs/*`
package depends only on other `@jarenjs/*` packages.

## Mode 1: npm packages (recommended)

```bash
npm install @jarenjs/validate @jarenjs/formats @jarenjs/refs
```

Published tarballs ship `src/`, `dist/types/` and the package docs, so types
resolve with no build on your side. Each release is gated by
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
git -C vendor/jarenjs checkout v0.22.13
```

**Do not use `--recursive`.** This repository's own submodules are external
conformance and benchmark corpora — the JSON-Schema-Test-Suite, the JSONPath
compliance suite, W3C qt3tests, toml-test and the CommonMark spec. They are
needed only to reproduce the upstream test gate and are irrelevant to
consuming the packages. A plain `git submodule update --init vendor/jarenjs`
in your CI checkout is what you want; `--recursive` pulls hundreds of
megabytes of fixtures you will never run.

### Pick the packages you actually need

The dependency arrow is one-way and cycle-free, so a subset is always
coherent. For server-side or browser **validation only**, five packages
suffice:

| Package | Needed for |
|---|---|
| `@jarenjs/core` | Foundation. Zero dependencies — everything sits on it |
| `@jarenjs/json` | Pointer/path addressing; required by `validate` |
| `@jarenjs/validate` | The validating compiler |
| `@jarenjs/formats` | Only if you use the `format` keyword |
| `@jarenjs/refs` | Only if you `$ref` the official meta-schemas offline |

`forms`, `view`, `app`, `locales`, `md`, `mermaid`, `calc`, `charts`, `josl`
and `ai` are independent of that set — leave them out unless you use them.

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
```

...or build stable local artifacts once and depend on those:

```bash
npm --prefix vendor/jarenjs run build
npm pack --pack-destination ./vendor/tarballs \
  --workspace=@jarenjs/core --workspace=@jarenjs/json \
  --workspace=@jarenjs/validate --workspace=@jarenjs/formats \
  --workspace=@jarenjs/refs
```

The tarball route costs an extra step per upgrade but gives you exactly what
npm consumers get, declarations included — worth it if your build treats
workspace symlinks differently from installed packages.

### Generate the TypeScript declarations first

This is the step that bites. `package.json` `types` and `exports` point at
`./dist/types/*.d.ts`, which **does not exist in a fresh checkout**:

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
