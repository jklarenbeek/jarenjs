# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through GitHub's security advisories:
[Report a vulnerability](https://github.com/jklarenbeek/jarenjs/security/advisories/new).
That opens a private thread visible only to the maintainer, and it is the
preferred channel because it can carry a coordinated fix and a published
advisory without the report being public first.

If you cannot use that form, email the maintainer at the address on the
[GitHub profile](https://github.com/jklarenbeek) with `SECURITY` in the
subject.

Useful things to include, as far as you have them: the affected package and
version, a minimal schema/document/query that reproduces the problem, what an
attacker gains, and whether you have already published anything about it.

This is a single-maintainer project, so please do not expect a same-day
answer. The commitment is: acknowledgement within **7 days**, an assessment
with a fix or a rejection within **30 days**, and credit in the advisory
unless you ask otherwise. If you plan to disclose publicly, 90 days from
acknowledgement is a reasonable default — tell us if you need faster.

## Supported versions

Jaren is pre-1.0 and all public workspaces share one version. Security fixes
land on the **latest released minor**; there are no long-term support
branches. If you are pinned to an older version, the upgrade path to the
latest patch of the current minor is the supported fix.

| Version | Supported |
| --- | --- |
| Latest minor (`0.22.x`) | ✅ |
| Anything older | ❌ — upgrade to the latest minor |

## What is in scope

The packages published from this repository, and specifically the properties
they claim:

- **Untrusted schemas, documents, queries and stylesheets.** All four are
  data that a Jaren consumer may receive from outside. A crash, a hang, an
  unbounded allocation, or an escape from the documented error model when
  processing any of them is a bug worth reporting. The query engine's
  execution limits (`options.limits`) exist for this and are documented in
  QUERY-FORMAT.md §10.3.
- **Prototype pollution.** Every path that turns an untrusted name into an
  object member goes through a proto-safe setter. A route that does not is a
  vulnerability, not a style issue.
- **The no-`eval` guarantee.** The compilers use no `eval` and no
  `new Function`, which is what makes them safe under a strict Content
  Security Policy. Any construction that reintroduces dynamic code evaluation
  is in scope.
- **The non-mutation guarantees.** Compiled validators do not modify their
  input; JSON Patch, the query write operations and the normalizer are
  copy-on-write. A path that mutates a caller's document is in scope.

## What is not in scope

- Denial of service from a schema, query or document you authored yourself
  and then fed to your own service. Jaren compiles what you give it; bounding
  *your* inputs is your application's job, and the execution limits are the
  tool for it.
- Vulnerabilities in a host application's use of the library — for example
  rendering unsanitized user content, or exposing a validator's error
  `params` (which deliberately carry the offending values) to a caller who
  should not see them.
- Anything in `benchmark/`, `packages/website/` or the vendored conformance
  submodules, which are development and demonstration code, not published
  packages.

## Supply chain

Every published `@jarenjs/*` package has **zero third-party runtime
dependencies** — the entire runtime dependency graph is other `@jarenjs/*`
packages, which you can verify mechanically from the manifests rather than
take on trust. Development dependencies (test runner, bundler, linter) are
not part of any published tarball.

Release tags are lightweight, so they are a pointer rather than an
independently verifiable object; a consumer pinning from source should pin the
resolved commit and review the gitlink diff on each upgrade. npm publishing
uses provenance where the registry supports it. See
[PUBLISHING.md](PUBLISHING.md) for the release procedure and the
compatibility policy.
