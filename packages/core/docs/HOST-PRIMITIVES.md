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
an absent target. Anchors are exact and unique, and by default span complete
lines; the final newline may be omitted. CRLF is preserved. Section operations
optionally accept an inclusive ending anchor `to`; without it they affect only
the anchor's lines unless a `sectionEnd` hook extends them (below). Links are
never interpreted. Replacement bytes are used verbatim, including their newline
convention: an insertion or a section that should end its line carries its own
final newline.

Hunks record zero-based half-open line intervals `[start, end)`, original edit
index `source`, path, base hash/text and replacement. By default overlaps are
withheld on both sides, including two insertions at one boundary or an insertion
at a replaced boundary. The compiler returns `valid`, `hunks`,
`withheld: [{edit, reason}]` and `groups`
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
Exceeding a bound throws a coded error (below) before application publishes a result. Anchor scans and
overlap checks are bounded by these inputs; no wall-time claim is made.
The host must re-read under its writer lock and own atomic multi-file persistence,
symlink policy and recovery. `scripts/preview-text-edits.js input.json` composes
this compiler with guarded asynchronous validation and a named Node syntax check;
it returns a reviewable preview without writing target files.

### Options for model-authored patches

A model writes anchors the way it reads a page, not on line boundaries, and
two proposals often rewrite one section. Three options, all off by default,
admit those patches without guessing; pass the same configuration to
`compileTextEdits` and `applyTextEdits`:

- **`anchor: 'widen'`** (default `'line'`) resolves an anchor, and a `to`,
  anywhere in the file and owns every line it touches, from the line holding its
  first character to the line holding its last. It must still occur exactly once:
  an ambiguous or missing anchor is withheld as `anchor-ambiguous` or
  `anchor-not-found`, as in line mode.
- **`sectionEnd: (lines, start, end) => number`** extends a `replace_section` or
  `delete_section` that has no `to`: it receives the file's lines (each with its
  own terminator) and the anchor's interval `[start, end)` and answers the
  section's exclusive end, a line from `end` to `lines.length`; any other answer
  throws `JE0017`. `markdownSectionEnd` is the Markdown rule: when the anchor's
  first line is an ATX heading of level n (up to three spaces of indentation, one
  to six `#`, then a space, a tab or the end of the line), the section runs to the
  first line after the anchor that is an ATX heading of level n or less, or to the
  end of the file. Lines inside a fenced code block (three or more backticks or
  tildes, closed by a run of the same character at least as long) are never
  headings, so a `# comment` in a shell block does not end a section; setext
  headings are not read. Any other anchor owns only its own lines.
- **`overlap: 'first-wins'`** (default `'withhold-both'`) keeps the first of two
  overlapping hunks in canonical order — path, start line, end line, replacement,
  group, then edit index, comparing text by code units, so reordering the edits
  changes neither the text nor which rewrite loses, unless two edits compile to the
  same hunk — and withholds the later one as `{ edit, reason: 'overlap', conflict }`,
  `conflict` naming the kept edit, which always applies. Groups compete whole: an
  ungrouped edit is a group of one, and a group takes its turn at its first hunk in
  canonical order, together with the groups it `requires`. It is kept only if none
  of those hunks crosses a hunk already kept; otherwise its crossing members are
  withheld as `overlap` naming the kept edit and the rest as `group-incomplete`. So
  a group whose first hunk sorts first also keeps its later hunks against rivals
  that would sort before them. A group whose own members cross each other, or cross
  a group it requires, is withheld with `overlap` rows that carry no `conflict`. A
  hunk already withheld for its own reason, or by its group, never wins. Under this
  policy an insertion conflicts only strictly inside another hunk's lines: two
  insertions at one boundary both apply, and so does an insertion at a replaced
  section's edge (before it at its start, after it at its end), all in canonical
  order whatever the order of the hunks passed to `applyTextEdits`. Two creates of
  one path still conflict.

The [package README](../README.md#text-edits-for-model-authored-patches) shows a
model-authored patch applied with all three.

The coded errors below are what a repair loop reads when a call throws rather
than withholds.

### Coded errors

A throw from `compileTextEdits` or `applyTextEdits` is a `CodedError` named
`TextEditError` whose `code` is one of `TEXT_EDIT_CODES` and whose `docPath`
points into `{ configuration, files, edits, hunks, result }`, naming the option,
file, edit or hunk at fault (`/edits/3/replacement`, `/hunks/1`,
`/configuration/anchor`). An unknown `anchor` or `overlap` value, or a
`sectionEnd` that is not a function, throws `JE0001` rather than being ignored.
*Upgrade: these throws were plain `RangeError`/`TypeError` instances without a
code; a host that matched on the class reads `code` instead. The reason keeps
the words the messages had (`stale-base`, `overlap`, `group-incomplete`,
`text byte limit exceeded`).*

| Code | Meaning |
|---|---|
| `JE0001` | an option is invalid: a limit outside its range, a hash or section hook that is not a function, or an unknown anchor or overlap policy |
| `JE0002` | the files, edits or hunks argument is not an array |
| `JE0003` | a file lacks a safe relative path, its text or its hash, or repeats another file's path |
| `JE0004` | a file's hash does not match its content under the configured hash |
| `JE0005` | more files than `maxFiles`, given or produced |
| `JE0006` | more edits or hunks than `maxEdits` |
| `JE0007` | more group dependency references than `maxEdits` |
| `JE0008` | the files' UTF-8 text exceeds `maxBytes` |
| `JE0009` | the edits' paths, anchors, groups and dependencies exceed `maxBytes` |
| `JE0010` | the replacements exceed `maxBytes` |
| `JE0011` | the applied files' UTF-8 text exceeds `maxBytes` |
| `JE0012` | a supplied hunk is malformed |
| `JE0013` | a supplied hunk's file no longer has the hunk's base hash and text |
| `JE0014` | a supplied hunk's line interval lies outside its file |
| `JE0015` | the supplied hunks do not carry every member of their groups and every group they require |
| `JE0016` | two supplied hunks overlap under the configured overlap policy |
| `JE0017` | the section hook answered an end that is not a line from the anchor's end to the file's end |

## Asynchronous guarded validation — `@jarenjs/core/guarded`

`createGuardedRefiner` keeps synchronous `prepare(document, proposal)`.
`prepareAsync` and serialized `commit(proposal)` await shape, apply, candidate and
planning hooks. Synchronous preparation refuses a hook's promise by throwing the
coded `JG0002` (`GuardedRefinerError`) instead of interpreting a Promise as a plan
or reporting it as a refused proposal. Async rejection is a failed verdict;
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
