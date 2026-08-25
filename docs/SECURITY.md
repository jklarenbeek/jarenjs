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
| Latest released minor (the newest `v*` tag; all workspaces share its version) | ✅ |
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
- **Hostile requests against a served contract.** `@jarenjs/contract`
  treats the contract document, the handlers and the app documents as
  trusted artifacts and **every request as hostile**, on every binding
  (`http`, `local`, `port`, `stream`). The claims, each one a tested
  property: the declared body-size limit is enforced before the body is
  read (413); decoded path/query/header values are assembled through a
  prototype-safe setter (no `__proto__` write); only headers the
  operation declares are read; malformed JSON, oversize and unsupported
  media settle into their coded responses; every request-time path
  **settles totally** — a hostile handler value, a throwing accessor or a
  rejected promise never escapes as an unhandled rejection; and no
  request value is echoed into an error message — validation details
  cross a binding only under the operation's declared
  `policy.errors.details` level (the default sends paths and keywords,
  never values). A request that crashes the server, bypasses a declared
  limit, writes a prototype, or leaks a request value through an error
  is a vulnerability worth reporting.

## What is not in scope

- **What `@jarenjs/contract` deliberately does not do**: authentication
  and authorization (the host's — compose them in front of the handler
  table), transport encryption (TLS belongs to the server or proxy that
  terminates the socket), and replay protection beyond idempotency keys
  (an `Idempotency-Key` deduplicates a declared command through the
  host's ledger; it is not a nonce scheme and does not authenticate the
  sender). Reports that amount to "the contract layer did not
  authenticate the caller" are out of scope by design.
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

## Untrusted query documents against a store

`@jarenjs/db` can run a query document that arrived from a tenant, a
remote client or a language model against a SQLite database. The
boundary is documented in MODEL-FORMAT.md §8 and enforced by the safe
execution profile; the properties it claims — and the ones it
deliberately does not — are these.

Claimed, and each proven by a hostile-input test:

- **Injection is structurally impossible.** Every literal and every
  external binds as a positional parameter; no value ever reaches SQL
  text, identifiers come only from the model document (validated
  names), and a member name the JSON path grammar cannot carry falls
  back to engine evaluation rather than being spliced.
- **Reference containment.** Under a profile, an undeclared external,
  host function, collation or collection is a compile error
  (`JD0011`) before anything executes, and a foreign document can
  never cause host-side function registration. The deterministic
  functions a spatial index needs (`jaren_geohash`, `jaren_bbox_*`,
  MODEL-FORMAT §3.1) are registered by the *model* the host opened,
  never by a query: they are pure functions of one stored member,
  read nothing else, and a query document cannot name one it did
  not already have through the declared index.
- **Bounded fetches.** Every non-aggregate fetch carries a mandatory
  `LIMIT`; crossing it is a coded refusal (`JD2007`), never a silent
  truncation. The engine's execution limits bound the JavaScript
  portion of any query with the engine's own codes.
- **Mandatory tenant predicates.** A profile predicate is conjoined
  into every plan after translation — native statements, residual
  candidate fetches and diverted scans alike — so no document shape
  removes it.
- **Denials do not wedge.** Every refusal leaves the store usable; the
  suite runs an ordinary query after each attack.
- **Read-only means the database refuses.** A read-only store opens
  the connection read-only at the driver, so a hypothetical
  translation bug still cannot write.

Not claimed, stated as plainly:

- **No statement timeout exists on the SQLite drivers.** `node:sqlite`
  and `bun:sqlite` expose no interrupt or progress handler, so a
  long-running database-internal computation is not bounded by the
  profile. The capability slot exists and is honestly `false`.
- **No row-estimate bound exists** — SQLite's plan output is prose;
  the structural full-scan refusal is the substitute.
- **A shared database is not safe for mutually hostile tenants
  without the mandatory predicate.** The profile is the mechanism,
  not a default.

A crash, a hang, an unbounded allocation, an escape from the coded
error model, or a cross-tenant read that defeats a mandatory predicate
while processing an untrusted query document is a vulnerability worth
reporting.

## A model-callable geo toolbox

`@jarenjs/ai`'s `createGeoToolbox` hands a language model seven tools
over `@jarenjs/core/geo`. Each is schema-guarded by the GeoJSON
meta-schema before it runs, computes nothing beyond one kernel call
over the arguments it was handed, performs no I/O and reaches no store
— a malformed geometry is refused with the validator's errors, an
overlay request is refused by name, and the tools can therefore be
published to a browser agent over WebMCP without widening what a model
can touch.

## Supply chain

Every published `@jarenjs/*` package has **zero third-party runtime
dependencies** — the entire runtime dependency graph is other `@jarenjs/*`
packages, which you can verify mechanically from the manifests rather than
take on trust. Development dependencies (test runner, bundler, linter) are
not part of any published tarball.

Release tags are lightweight, so they are a pointer rather than an
independently verifiable object; a consumer pinning from source should pin the
resolved commit and review the gitlink diff on each upgrade.

**Publishing carries no provenance attestation today.** Releases are published
manually by the maintainer, not from CI, so there is no OIDC trusted-publishing
record linking a tarball to the workflow run and commit that produced it, and
no signed tag to check instead. Treat the git history as the authoritative
artifact: pin the resolved commit, verify it against this repository, and build
from source if your threat model needs more than the registry's word. Wiring
provenance is tracked in [PUBLISHING.md](workflow/PUBLISHING.md). See
[PUBLISHING.md](workflow/PUBLISHING.md) for the release procedure and the
compatibility policy.
