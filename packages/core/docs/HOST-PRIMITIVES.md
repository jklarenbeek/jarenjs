# Paired inference, text proposals and process ownership

These opt-in modules provide generic mechanics. Hosts own evaluation policy,
authority, persistent storage and external writers. Browser imports of core's
root, stats, search and text modules do not load the Node process executor.

## Paired inference — `@jarenjs/core/stats`

`pairedBootstrap(pairs, {resamples, seed, level = 0.95, statistic =
'mean-difference', quantile = 'nearest-rank', maxWork = 10000000})` returns
`{estimate, lower, upper, resamples, seed, level, method, quantile}`. One pair is
one shared observational unit; the difference is **second minus first**. Sampling
uses `mulberry32`, summing sampled precomputed differences in draw order. The seed
must be a safe integer and is reported normalized to unsigned 32 bits. Inputs must
be nonempty finite number pairs; resamples must be 1–1,000,000 and
`pairs.length * resamples <= maxWork` (configurable up to 100,000,000).

The percentile endpoints use the existing explicit `quantile` methods. A custom
`statistic(a, b)` receives fresh paired arrays and must return a finite number;
the callback owns its determinism and computational cost. The default arithmetic
and PRNG draw order are fixed by fixtures. This is a percentile bootstrap, not
BCa; it does not choose the host's sampling units or significance policy.

`permutationTest(pairs, {resamples, seed, statistic, maxWork, alternative =
'two-sided'})` uses independent paired label swaps with the same work bounds.
Alternatives are `two-sided`, `greater`, `less`; ties count as extreme.
`pValue = (extreme + 1) / (resamples + 1)` and `exact: false` identify Monte Carlo
sampling, including when the number of draws exceeds the number of distinct swaps.
The result also records estimate, resamples, seed, alternative and method.

The suite's lexical instrument resamples each shared query's five-sample mean
latency. `benchmark/hybrid-retrieval.js` compares recall over judged queries using
both functions. Those intervals describe the supplied workload; repeated timing
samples are not treated as independent queries.

## Text proposals — `@jarenjs/core/text/edits`

```js
import { hashContent } from '@jarenjs/core/string';
import { compileTextEdits, applyTextEdits } from '@jarenjs/core/text/edits';

const text = '# Title\nOriginal\n';
const files = [{ path: 'note.md', text, hash: hashContent(text) }];
const proposal = compileTextEdits(files, [{ op: 'replace_section',
  path: 'note.md', baseHash: files[0].hash, anchor: 'Original',
  replacement: 'Revised\n' }]);
if (proposal.valid) {
  const preview = applyTextEdits(files, proposal.hunks);
  // Review preview.diff; files and the filesystem are unchanged.
}
```

Each file has a unique relative POSIX `path`, `text` and content `hash`.
Absolute paths, empty/dot/parent segments, backslashes, colons and control
characters are refused. Compilation verifies the supplied file hash. The default
`hashContent` is a fast change detector, **not a cryptographic authenticity check**;
a host needing stronger identities injects a synchronous `hash(text)` consistently
into compilation and application. Applying a hunk also compares its exact
`baseText`, so a changed source cannot pass through a hash collision alone.

Operations are `create_file`, `insert_before`, `insert_after`, `replace_section`
and `delete_section`. Existing targets require their `baseHash`; creates require
an absent target. Anchors are exact, unique and span complete lines; the final
newline may be omitted. CRLF is preserved. Section operations optionally accept
an inclusive ending anchor `to`; without it they affect only the anchor's lines.
There is no Markdown heading or link interpretation. Replacement bytes are used
verbatim, including their newline convention.

Hunks record zero-based half-open line intervals `[start, end)`, original edit
index `source`, path, base hash/text and replacement. Overlaps are withheld,
including two insertions at one boundary or an insertion at a replaced boundary.
The compiler returns `valid`, `hunks`, `withheld: [{edit, reason}]` and `groups`
(path arrays). Refusal reasons include `anchor-not-found`, `anchor-ambiguous`,
`anchor-not-line-boundary`, `overlap`, `stale-base`, `missing-target`, `path-unsafe`,
`invalid-edit` and `group-incomplete`.

Use the same explicit `group` on a create and its linking edit. `requires` names
other explicit groups. Missing/cyclic dependencies, or one failed member, withhold
the whole dependent group. Independent valid groups remain in `hunks`, but
`valid` is false if anything was withheld. Application checks complete group
membership, dependencies, bases and intervals again, returns copies and a unified
whole-file diff, and performs **no I/O**. Group metadata is a consistency check,
not a signed authorization token: the host must retain its reviewed proposal.

Default bounds are 256 files, 256 edits and 4 MiB UTF-8 text/replacements/result
(separate credits, including proposal metadata), with at most maxEdits dependency references; maximum configurable bounds are 4096 files/edits and 64 MiB.
Exceeding a bound throws before application publishes a result. Anchor scans and
overlap checks are bounded by these inputs; no wall-time claim is made.
The host must re-read under its writer lock and own atomic multi-file persistence,
symlink policy and recovery. `scripts/preview-text-edits.js input.json` composes
this compiler with guarded asynchronous validation and a named Node syntax check;
it returns a reviewable preview without writing target files.

## Asynchronous guarded validation — `@jarenjs/core/guarded`

`createGuardedRefiner` keeps synchronous `prepare(document, proposal)`.
`prepareAsync` and serialized `commit(proposal)` await shape, apply, candidate and
planning hooks. Synchronous preparation refuses thenables with a validation error
instead of interpreting a Promise as a plan. Async rejection is a failed verdict;
no commit occurs. Every hook works on copied JSON; candidate/planning mutation
cannot change the reader's document. Prepared values are captured before an
asynchronous snapshot suspends. `commitPrepared` still requires the host's external
writer serialization and approved/still-current prepared input.

## Named processes — `@jarenjs/core/process-node`

```js
import { createProcessExecutor } from '@jarenjs/core/process-node';
const executor = createProcessExecutor({ cwd: process.cwd(),
  allow: { syntax: { argv0: process.execPath, args: [/--check/] } },
  timeoutMs: 5000, maxStdoutBytes: 4096, maxStderrBytes: 8192 });
try {
  const result = await executor.run({ name: 'syntax', args: ['--check'],
    input: 'const answer = 42;\n' });
  // Check result.exitCode, result.settlement and truncation before accepting.
} finally { await executor.close(); }
```

The host registers absolute executables by name. No shell is used. Each allowed
argument RegExp matches a whole argument; array length must match exactly. Omitted
`args` allows no arguments. A trusted predicate may validate the whole immutable
argv instead. Request `cwd` resolves under the configured realpath root; a realpath
escape is refused before spawning. Environment inheritance and request overrides
are limited to `env.allow` (empty by default). This is process ownership, **not an
OS sandbox**: commands can access files/network and spawn detached sessions;
realpath checking cannot eliminate filesystem races. Host callbacks are trusted.

Defaults: timeout 30 s, termination grace 1 s, 1 MiB each for stdout, stderr,
stdin and argv/environment byte credits, four active owners, at most 1024 args.
Byte caps may be 0–64 MiB; owners 1–1024; grace 1–60,000 ms; timeout
1–2,147,483,647 ms. `killSignal` accepts SIGTERM, SIGINT or SIGKILL. Output is
captured only up to each cap with explicit `truncated` flags (UTF-8 may end in a
replacement character). Continued output is drained. Resource usage is not
fabricated: `capabilities.resourceUsage` is false; no RSS figure is returned.

Results contain exitCode, signal, stdout/stderr, truncation, durationMs and
`settlement: 'not-started' | 'closed' | 'unresolved'`, plus `refused` or `reason`
when applicable. Refusals include unknown-command, argument-rejected, input-rejected,
env-rejected, cwd-escape, request-rejected, cancelled, capacity, closed and
tree-unsupported. Fault/stop reasons include timeout, cancelled, closed,
spawn-error, process-error, input-error and drain-timeout.

POSIX defaults to an owned process group; timeout/abort/close signal the group,
escalate to SIGKILL after grace, and report unresolved after twice grace if no
close arrives. Remaining group members are killed when the parent exits. Windows
supports direct-child ownership only (`tree: 'child'`, the default there); an
explicit group request refuses. `capabilities.processGroups` reports this boundary.
No guarantee covers a descendant that escapes its group. A child exit with stalled
pipes starts a drain deadline. Capacity remains charged until the actual close
notification, even after an unresolved result. `close()` stops admission and
returns the active results; unresolved ownership stays visible in `stats()`.
