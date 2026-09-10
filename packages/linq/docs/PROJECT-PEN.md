# The project pen

> `./project` — Studio projects with named, typed files. **Read it when** you
> want a portable editor workspace containing documents written by several pens.

## 1. What it writes

`@jarenjs/linq/project` writes the public `project: "0.1"` envelope. File text
stays byte-for-byte intact. `jsonFile()` serializes a JSON value once; pass a
schema or another pen's `.schema` explicitly. The pen imports no Studio engine.

Every update returns a new builder with a deeply frozen JSON snapshot. Studio's
`parseProject()` validates the envelope, resolves its active file and supplies
layout defaults. `validateFile()` checks each file through its own engine.

## 2. The mapping table

| Method | Emits | Type | Status |
|---|---|---|---|
| `file(name, kind, text, options?)` | `{ name, kind, text }` and optional routing/import members, preserving text | literal name/kind | native |
| `jsonFile(name, kind, document, options?)` | same file, with serialized JSON text | literal name/kind | native |
| `defineProject(files?, options?)` | version, files, optional active/layout | names from files | native |
| `.files(files)` | replacement file list | replaces known names | native |
| `.file(file)` | appended file | adds its name | native |
| `.active(name)` | requested active name | existing name | native |
| `.layout(options)` | replacement layout | mode, ratio, autorun | native |
| `from(document)` | raw project envelope | arbitrary names | native |
| `.schema`, `.toJSON()` | frozen public document | project document | native |

## 3. Worked examples

```js
import { defineProject, jsonFile } from '@jarenjs/linq/project';
export const project = defineProject([jsonFile('data.json', 'data', { count: 2 })])
  .active('data.json').layout({ mode: 'right', ratio: 0.4, autorun: true });
```
```json
{"project":"0.1","files":[{"name":"data.json","kind":"data","text":"{\"count\":2}"}],"active":"data.json","layout":{"mode":"right","ratio":0.4,"autorun":true}}
```

Call `parseProject(project.schema)` from `@jarenjs/studio`. A parsed nonempty
project round-trips through JSON and the parser unchanged. Empty projects are
valid; the parser represents their absent active file as `null` internally.

File options preserve `imports`, `input`, `model` and `collection`. For example,
`jsonFile('app', 'app', { view: [] }, { imports: { state: 'seed' } })` supplies
state from another file; `file('q', 'query', '"$"', { model: 'store', collection:
'notes' })` routes a query to a store. The pen snapshots these values without
resolving them. Studio checks missing references, cycles and execution kinds.

## 4. Refusals

| Code | Condition |
|---|---|
| `JL0101` | a missing/empty filename, unknown kind or option, non-string text/active name, non-array files, or a non-JSON input |

Studio refuses duplicate filenames with `JS0002`. A missing active filename
falls back to the first file; it is not a parser error. Layout ranges, malformed
file contents and document semantics are validated at the Studio boundary. The
pen preserves these behaviors and does not carry a second project validator.

## 5. The types

`ProjectBuilder<Names>` tracks file names only in declarations. `FILE_KINDS`
contains the schema's file-kind vocabulary, checked against Studio's own set.
`ProjectFile<Name, Kind>`, `ProjectFileOptions`, `FileKind`, `ProjectLayout` and `ProjectDocument` are
types. `JsonInput` accepts readonly structural documents and leaves unknown
schema extension values to the runtime JSON check. `.files()` replaces the name union and `.file()` widens it. `.active()`
refuses an undeclared literal name in TypeScript. `from()` deliberately keeps
names broad. Neither duplicate detection nor numeric range proofs are claimed.

## 6. What it cannot spell

File contents are text, not live editors or engine objects. JSON files accept
only JSON data. The envelope does not embed every file grammar: query registries,
app rendering and contract checks remain the file engines' responsibilities.

## 7. Cost

The isolated project pen costs **<!--fact:bundle.project-->15,225<!--/fact--> bytes**.
Its tree probe excludes Studio, other target engines and the query chain.
