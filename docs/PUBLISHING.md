# Publishing the Jaren packages

The repository root and the benchmark/website workspaces are private. A
release publishes the fifteen public workspaces:

- `@jarenjs/core`
- `@jarenjs/json`
- `@jarenjs/validate`
- `@jarenjs/formats`
- `@jarenjs/refs`
- `@jarenjs/forms`
- `@jarenjs/locales`
- `@jarenjs/view`
- `@jarenjs/app`
- `@jarenjs/md`
- `@jarenjs/mermaid`
- `@jarenjs/calc`
- `@jarenjs/charts`
- `@jarenjs/josl`
- `@jarenjs/ai`

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
  reading nothing.
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
- **Security fixes land on the latest minor** — see [SECURITY.md](SECURITY.md).
  There are no support branches for older minors.
- **What 1.0 means here**: the per-package items in [ROADMAP.md](ROADMAP.md)
  are the gate. After 1.0 this policy becomes ordinary semver, with breaking
  change confined to majors.

Consumers who need a stronger guarantee than pre-1.0 minors provide should
pin a reviewed tag and upgrade deliberately; the recipe is in
[CONSUMING.md](CONSUMING.md#upgrading-a-pin).

## Prepare a release

All public workspaces use one version. Increment them and their internal dependency ranges together:

```bash
npm run version:patch
# or: npm run version:minor
# or: npm run version:major
```

Review and commit the resulting manifest changes. The release gate runs lint, all tests, all builds, a TypeScript consumer check, a tree-shaking check, and npm tarball dry runs:

```bash
npm run release:check
```

CI runs this same gate on **Linux and Windows both**, because a
Windows-only failure is a release failure — packed-consumer portability,
glob quoting and newline normalization are all platform classes of defect
that a Linux-only green hides. A separate `browser` job runs the website's
Playwright suite in Chromium, Firefox and WebKit. QT3 conformance and the
dead-code audit are deliberately *not* part of this gate (they need the
`qt3tests` submodule and a long coverage pass); they are separate evidence
runs, so a green CI does not silently imply them.

## Publish

**Bun is mandatory for a release.** The release gate's packed-consumer
step runs in `--require-bun` mode (`npm run test:packed:release`): every
packed package must import from its declared closure under Node AND Bun,
strict packed TypeScript must resolve, and the `@jarenjs/app` closure
must bundle under an isolated Vite build. A machine without a `bun`
binary on `PATH` fails the gate before anything is packed — install Bun
before publishing.

The root command reruns the release gate and publishes only the fourteen public workspaces:

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
[CONSUMING.md](CONSUMING.md#upgrading-a-pin) — which is the control that
matters here.

After publishing, verify the versions:

```bash
npm view @jarenjs/core version
npm view @jarenjs/json version
npm view @jarenjs/validate version
npm view @jarenjs/formats version
npm view @jarenjs/refs version
npm view @jarenjs/forms version
npm view @jarenjs/locales version
npm view @jarenjs/view version
npm view @jarenjs/app version
npm view @jarenjs/md version
npm view @jarenjs/mermaid version
npm view @jarenjs/calc version
npm view @jarenjs/charts version
npm view @jarenjs/josl version
npm view @jarenjs/ai version
```

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
