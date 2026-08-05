# The Jaren live format — change capture and live queries

This document is normative. The key words MUST, MUST NOT, SHOULD and
MAY are to be interpreted as described in RFC 2119.

Change capture and live queries are ONE story — patches out — and
share this document. This order writes §§1–6 (capture); live queries
continue at §7. Error codes join the package's single runtime table
(MODEL-FORMAT §7), never a per-document list.

## 1. Scope

Every committed write to a store opened with `capture` produces an
observable, ordered stream of **RFC 6902 patches** describing what
changed — derived from SQLite's own session changesets where the
binding has them, from a write-path journal where it does not. One
diff format then runs end to end: store → patch → live query → patch
→ O(k) render. The patches MUST be consumable by
`applyJSONPatch` from `@jarenjs/json/patch`, unmodified.

```js
const store = await openStore(model, {
  driver: nodeDriver(),
  capture: { mode: 'auto', log: { retention: 1000 } },
});
const stop = store.observe(({ seq, at, source, collections, patch }) => {
  // one record per committed transaction, in commit order
});
```

Capture is **opt-in per store** — it costs a transaction wrapper and
(in session mode) a session per commit; the measured overhead is
published with the benchmarks, not waved away.

## 2. The pointer contract

Every op's `path` is `/<table>/<key>/<path…>`, each token escaped per
RFC 6901 (`~` → `~0`, `/` → `~1`):

- `<table>` is the collection, entity or join-table name.
- `<key>`: a SINGLE key renders as its scalar text (integers in
  decimal); a COMPOSITE key renders as the JSON text of its parts
  array (`["ada","math"]`), then escaped as one token. The encoding is
  deterministic: parts appear in declared key order.
- `<path…>` is the document-relative remainder, RFC 6901 as always.

The contract is stable — consumers depend on it. Join-table rows are
tiny documents under the join table's name (`/Label_User/["admin","u1"]`
→ `{ "Label_key": "admin", "User_key": "u1" }`, columns in the sorted
pair order): membership changes are part of the stream, not a blind
spot.

**Op order within a record is UNSPECIFIED.** A commit carries one net
op per row (SQLite sessions coalesce insert+update, drop
insert+delete, omit no-op updates — and the journal mirrors that
discipline), every op targets a distinct pointer, and the record
applies correctly in any order. The two capture modes MAY order the
same ops differently; they MUST agree as sets.

## 3. The op mapping

| Row change | Patch |
|---|---|
| INSERT | `add` at `/<table>/<key>` with the full document (mapped columns folded back: booleans as `true`/`false`, SQL `NULL` absent, derived epoch columns skipped — the document string is authoritative) |
| DELETE | `remove` at `/<table>/<key>` |
| UPDATE, document column changed | old JSONB diffed against new (`createJSONPatch`) → minimal nested ops under `/<table>/<key>` |
| UPDATE, mapped scalar/foreign-key column changed | property-level op at `/<table>/<key>/<property>`: `replace` (both present), `add` (was `NULL`), `remove` (now `NULL` — absent per MODEL-FORMAT §9.3) |
| join-table INSERT / DELETE | `add` / `remove` of the membership row document |

Changesets (not patchsets) are used because they carry OLD values —
that is what makes the minimal nested diff and the add/remove/replace
discrimination possible; the price is a larger in-memory blob per
transaction, stated here. Integer values beyond ±2⁵³ convert lossily
to JS numbers (a raw-SQL concern only; JS documents cannot produce
them).

## 4. Capture modes and their limitations

`capture.mode` is `'auto'` (default), `'session'` or `'journal'`;
`store.capabilities.capture` reports what actually runs
(`'session'`, `'journal'` or `'none'`).

- **`session`** — SQLite's session extension records row changes at
  the storage layer: every write through this connection is seen,
  including future raw-SQL surfaces. Requires the binding to expose
  `createSession` (node:sqlite does; **bun:sqlite does not**; a wasm
  build may not). Sessions are per COMMIT, never long-lived (an
  unbounded session is a memory leak); a rolled-back transaction —
  and a rolled-back savepoint inside a committed one — contributes
  nothing (probed and pinned by test).
- **`journal`** — the write path itself emits records: the store
  already knows what it wrote. **Less complete, stated plainly**: it
  cannot see writes made through raw SQL, triggers, or another
  connection; a journal-mode delete of a row the store never read
  emits its `remove` without having seen the old document; and of the
  database's own `ON DELETE` side effects it reconstructs exactly ONE
  — join-table membership dying with its entity (read before the
  delete) — while cascades into CHILD rows (`onDelete: 'cascade'` /
  `'setNull'` on one-to-many relations) stay invisible. For writes
  made through the store API within those bounds the two modes MUST
  produce the same op sets — proven by a differential test.
- Requesting `mode: 'session'` on a driver without sessions is a
  `TypeError` at open — an application that needs completeness can
  refuse to start rather than silently miss changes.

## 5. The persisted log and retention

With `capture.log`, each record is appended to `_jaren_changes`
**inside the same transaction** as the writes it describes — an
observer crash cannot lose a committed record, and a late joiner
reads forward:

```js
const records = await store.changesSince(lastSeq);  // JD2051 when no log
```

`seq` is monotonic; with the log enabled it continues across reopens
(seeded from `MAX(seq)`), without it it is per-process. Retention is
a bounded count (`retention`, default 1000): older rows are pruned in
the same transaction. The log is an ordered, replayable stream —
which is what makes a late-joining consumer possible. **Replication
is not built here**, and this log alone does not make it safe: there
is no conflict resolution, no site identity, no causal ordering
across writers. That sentence is the whole claim.

## 6. Cross-connection behaviour and non-claims

Another process (or another connection) writing to the same file
produces NO local patches — sessions and journals are per-connection
facts. The honest mitigation is a coarse signal, not a pretend
fine-grained one: `store.dataVersion()` reads `PRAGMA data_version`,
which changes when ANOTHER connection commits; poll it and treat a
change as "re-read what you care about". Cross-tab delivery is §7's
story (the live-query layer).

Non-claims, in one place: no replication, no conflict resolution, no
capture of writes made by other connections, no capture on stores
opened without `capture`, and no statement-level ordering within a
commit (§2).
