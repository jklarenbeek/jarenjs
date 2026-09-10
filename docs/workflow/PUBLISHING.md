# Publishing the Jaren packages

The repository root and the benchmark/website workspaces are private. A
release publishes these public workspaces:

- `@jarenjs/core`
- `@jarenjs/json`
- `@jarenjs/validate`
- `@jarenjs/formats`
- `@jarenjs/refs`
- `@jarenjs/emit`
- `@jarenjs/contract`
- `@jarenjs/forms`
- `@jarenjs/locales`
- `@jarenjs/view`
- `@jarenjs/app`
- `@jarenjs/md`
- `@jarenjs/mermaid`
- `@jarenjs/calc`
- `@jarenjs/charts`
- `@jarenjs/collection`
- `@jarenjs/studio`
- `@jarenjs/play`
- `@jarenjs/josl`
- `@jarenjs/ai`
- `@jarenjs/flow`
- `@jarenjs/linq`
- `@jarenjs/db`

## Authenticate locally

The simplest interactive option is:

```bash
npm login
npm whoami
```

To use a granular npm access token instead, create one on npmjs.com with read/write access to the `@jarenjs` scope. Keep "Bypass 2FA" disabled for an interactive local release; enable it only when a genuinely non-interactive publisher requires it.

Install the token in the user-level npm configuration without putting its value in shell history:

```bash
read -rsp "npm token: " NPM_TOKEN
echo
npm config set //registry.npmjs.org/:_authToken="$NPM_TOKEN" --location=user
unset NPM_TOKEN
chmod 600 "$(npm config get userconfig)"
npm whoami
```

Never put the token itself in this repository's `.npmrc`. Revoke and replace it immediately if it is committed or printed in a shared log.

## Compatibility policy

Jaren is pre-1.0. All public workspaces share one version and are released
together, so a version number describes the suite, not a single package.

- **Patch releases never break a public API.** Bug fixes, performance work,
  documentation and additive internals only. Upgrading a patch should require
  reading nothing — *except* for the conformance carve-out below, which is
  the one case where a patch can change what you observe.
- **Minor releases may break a public API**, and when one does it is called
  out in the documentation of whatever changed, and is visible in the commit
  range between the two tags. Pre-1.0 this is the release that carries
  breaking change; there is no separate major channel yet. There is no
  changelog file on purpose — the git history between two tags *is* the
  changelog, and a second hand-written copy of it only goes stale. Tags are
  lightweight, so they carry no annotation to read: `git log v0.22.15..v0.22.16`
  is the release note.
- **Deprecations get one minor of overlap.** A symbol slated for removal is
  documented as deprecated in the release that supersedes it, keeps working
  for that whole minor series, and may be removed in the next minor. A
  deprecation is never introduced and removed in the same minor.
- **Behavior changes count as API changes.** A validator that starts
  reporting different errors for the same schema and document is a breaking
  change even though no signature moved, and it is versioned as one.
- **Conformance fixes are the exception, and they land on patch.** When the
  validator was simply *wrong* — a diagnostic that should never have been
  reported, a constraint that silently did not assert, a verdict that
  contradicted the specification — the fix ships on the next patch. Holding a
  known-wrong validator back for a minor leaves every consumer wrong in the
  meantime, which is worse than the upgrade cost. The trade is that such a
  patch is **named**: the commit subject says what changed, and consumers who
  assert on exact error sets should read it.

  Being concrete rather than abstract about it, because these are recent and
  a consumer pinning ranges will have crossed them:

  | Release | What observably changed |
  |---|---|
  | `v0.22.17` | Independent keyword failures became exhaustive; more errors for the same document |
  | `v0.22.24` | Speculative applicators (`anyOf`/`oneOf`/`not`/`if`/`contains`) stopped leaking probe errors; `$ref` began reporting alongside its siblings |
  | `v0.22.25` | Generated TypeScript changed shape: objects open by default, parenthesized unions, quoted keys |
  | `v0.22.26` | A lone `if` stopped leaking; `not: true` gained a diagnostic; `$ref` siblings follow the resource's own draft; **absolute `$data` pointers now assert at all**, so documents that wrongly passed now fail, and an uncompilable `$data` reference is a compile error |

  The last of those changed *verdicts*, not just messages. It is the clearest
  case for the carve-out: `{ "maximum": { "$data": "/limit" } }` had never
  constrained anything, and a validator that quietly enforces nothing is not
  something to keep for compatibility's sake.
- **Security fixes land on the latest minor** — see [SECURITY.md](../SECURITY.md).
  There are no support branches for older minors.
- **What 1.0 means here**: the per-package items in [ROADMAP.md](../ROADMAP.md)
  are the gate. After 1.0 this policy becomes ordinary semver, with breaking
  change confined to majors.

Consumers who need a stronger guarantee than pre-1.0 minors provide should
pin a reviewed tag and upgrade deliberately; the recipe is in
[CONSUMING.md](../CONSUMING.md#upgrading-a-pin).

## Prepare a release

All public workspaces use one version. One command increments them and their internal dependency ranges together, syncs the lockfile and re-verifies the build:

```bash
npm run release:bump            # patch
# or: npm run release:bump -- minor
# or: npm run release:bump -- major
```

It runs the npm that launched it — `npm run` publishes its own CLI path as `npm_execpath`, and the bump executes that file under the current Node with a fixed argument vector (no PATH lookup, no shell, no `.cmd` shim on Windows) — and **refuses under an npm that is not the `packageManager` pin** before it writes anything — see the lockfile note below for why that is the first thing it checks. Invoked as `node scripts/release-bump.js`, or under pnpm/yarn, it refuses too: there is no executing npm to run. It then runs `scripts/version-packages.js`, `npm install`, `npm run test:lock` and `npm run build`. (The bare `npm run version:patch|minor|major` still exists and is what it calls; use it only when you deliberately want the manifest edit without the rest.)

Review the resulting manifest changes. The release gate is every gate the working path runs ([`CONVENTIONS.md`](CONVENTIONS.md) §2 — lint, tests, website build, the dead-code audit, the figure gate, the document gate, the design sweep and the three-engine browser matrix) plus the packaging evidence a release additionally needs: a portable-lock check, a native-toolchain probe, a clean rebuild, a TypeScript consumer check, tree-shaking, packed consumers under Node **and** Bun, a source-consumer fixture, a dependency check and npm tarball dry runs:

```bash
npm run release:check
```

CI runs the same **packaging** half on **Linux and Windows both**, because a
Windows-only failure is a release failure — packed-consumer portability,
glob quoting, newline normalization, `.cmd` shims, drive-letter paths and
per-platform native packages are all platform classes of defect that a
Linux-only green hides. A separate `browser` job runs the website's
Playwright suite in Chromium, Firefox and WebKit, and the source-consumer
fixture runs on Linux **and Windows**. CI does *not* run QT3 conformance or
the dead-code audit (they need the `qt3tests` submodule and a long coverage
pass), so a green CI does not imply them — but `release:check` does run the
dead-code audit, which is the point of running it before publishing rather
than trusting the CI badge.

**The lockfile is written by one npm.** The root `packageManager` field
names it (npm 11.12.1). An older npm rewrites `package-lock.json` without
other platforms' native packages (npm/cli#7961, fixed in npm 11.3) — a
Linux lock rewrite is how the Windows `tsc` once lost its own executable.
`npm run test:lock` proves the lock's platform completeness structurally
and runs before every CI install; if it goes red after a local install,
regenerate the lock with the pinned npm from the last complete baseline
rather than committing the pruned one.

## Publish

**Bun is mandatory for a release.** The release gate's packed-consumer
step runs in `--require-bun` mode (`npm run test:packed:release`): every
packed package must import from its declared closure under Node AND Bun,
strict packed TypeScript must resolve, and the `@jarenjs/app` closure
must bundle under an isolated Vite build. A machine without a `bun`
binary on `PATH` fails the gate before anything is packed — install Bun
before publishing.

The root command reruns the release gate and publishes only the public workspaces listed above:

```bash
npm run publish
```

npm may prompt for a one-time password when account/package policy requires 2FA.

### Tag the release

```bash
git tag v<new-version>
git push && git push --tags
```

Tags are lightweight and the version lives only in the tag, never in the
commit message. A consumer pinning a source checkout pins the commit the tag
resolves to and reviews the gitlink diff on every upgrade — see
[CONSUMING.md](../CONSUMING.md#upgrading-a-pin) — which is the control that
matters here.

After publishing, verify the versions:

```bash
npm view @jarenjs/core version
npm view @jarenjs/json version
npm view @jarenjs/validate version
npm view @jarenjs/formats version
npm view @jarenjs/refs version
npm view @jarenjs/emit version
npm view @jarenjs/forms version
npm view @jarenjs/locales version
npm view @jarenjs/view version
npm view @jarenjs/app version
npm view @jarenjs/md version
npm view @jarenjs/mermaid version
npm view @jarenjs/calc version
npm view @jarenjs/charts version
npm view @jarenjs/collection version
npm view @jarenjs/studio version
npm view @jarenjs/josl version
npm view @jarenjs/ai version
npm view @jarenjs/flow version
npm view @jarenjs/play version
npm view @jarenjs/linq version
npm view @jarenjs/db version
```

The list above is every workspace the root `publish` script names — check
it against `package.json` rather than trusting this copy, and keep the two
in step when a package is added.

## Provenance

npm **trusted publishing with OIDC** is the intended default for automated
releases, in preference to a long-lived write token: it removes the
long-lived credential entirely and attaches a provenance attestation linking
each tarball to the workflow run and commit that produced it. Publish with
`--provenance` from CI once that is wired.

The SBOM story is short enough to state rather than generate: every published
`@jarenjs/*` package has **zero third-party runtime dependencies**, so the
runtime dependency graph of any of them is other `@jarenjs/*` packages and
nothing else. A consumer can verify that mechanically from the published
manifests.
