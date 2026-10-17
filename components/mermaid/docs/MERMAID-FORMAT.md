# The Jaren Mermaid Format

**Version 0.1 — Specification**

Module: `@jarenjs/mermaid`. This document is the normative contract for
the `DiagramDocument` — the JSON vocabulary a Mermaid diagram parses into
— and the bidirectional round-trip between Mermaid text and that AST. It
plays the role for diagrams that [MD-FORMAT](../../md/docs/MD-FORMAT.md)
plays for Markdown.

## 1. Introduction

### 1.1 What this format is

`@jarenjs/mermaid` parses Mermaid diagram source into a plain-JSON,
**geometry-free** AST wrapped in a `DiagramDocument` envelope. The AST
carries the diagram's *meaning* — a directed graph, an ordered
interaction, a finite state machine — and no coordinates: layout is a
separate, later pass. This makes the AST a faithful, lossless,
schema-validated semantic model that other engines project via JSLT, and
a fixed point of the canonical printer `toMermaid`.

### 1.2 Non-goals (v0.1)

Pixel-identity with browser-Mermaid is an explicit **non-goal**. Labels
are SVG `<text>` (Mermaid `htmlLabels: false` semantics) unless the host
enables HTML labels for flowchart and state diagrams (§3, §7) — the
reverse of Mermaid's default, which is HTML. Layout is a deterministic
approximation over a headless text-metrics table (no `getBBox`), for HTML
labels too. See §6.

## 2. The DiagramDocument envelope

Every parse returns a fresh, never-mutated object:

```jsonc
{ "$mermaid": "0.1",
  "diagram": "flowchart",
  "config":  { "theme": "default", "flowchart": { "curve": "basis" } },
  "ast":     { "...type-specific, monomorphic, geometry-free..." },
  "meta":    { "hash": "8k41x2", "direction": "TD", "title": null } }
```

| Field | Meaning |
|-------|---------|
| `$mermaid` | format version (`"0.1"`) |
| `diagram` | canonical type: `flowchart`, `sequence`, `class`, `er`, `state`, `gantt`, `pie`, or a secondary type name |
| `config` | plain-JSON config from front-matter + `%%{init}%%` (§3) |
| `ast` | the type-specific AST (§4) |
| `meta.hash` | `hashContent(source)` — FNV-1a 32-bit, base-36; the identity key across the suite |
| `meta.direction` | flowchart direction, else `null` |
| `meta.title` | front-matter `title`, else `null` |

## 3. Config

Two sources merge into `config` (plain JSON), in source order:

1. A leading `---` front-matter block (a YAML subset): `title` lifts to
   `meta.title`, `config:` merges into `config`, and a top-level
   `displayMode:` is copied to `config.gantt.displayMode` after that merge,
   so it wins over a `displayMode` written under `config:` (Mermaid's
   shorthand for the compact Gantt, §4.4). The value is kept as its text
   and an empty or false one writes nothing. This happens for every diagram
   type, as in Mermaid, so `toMermaid` writes the member back in the `init`
   header it prints for the config.
2. `%%{init: { … }}%%` directives (relaxed JSON: single quotes and bare
   keys tolerated).

Whole-line `%%` comments are stripped. The **raw source is never
consumed** — it stays in the Markdown fence `value`, so `toMarkdown`
round-trips byte-for-byte while a node is untransformed (§5).

The engine may not statically import `@jarenjs/md`; a host with the md
frontmatter parser can inject it via `parseMermaidConfig(source, {
parseFrontmatter })`, otherwise the built-in YAML subset is used.

**HTML labels are the host's to enable.** A flowchart or state diagram
draws its labels as HTML (§7) only when the host passes `htmlLabels: true`
in the render options (`renderMermaid`, `diagramToVnode`, `compileMermaid`,
`layoutDiagram`, `createMermaidRenderer`, `mermaidPlugin`,
`createMermaidComponent`). A diagram's own `htmlLabels` cannot turn them
on, so no author's directive can blank the labels on a host that renders
through the `@jarenjs/view` safe policy (§7); it can turn them off, as
Mermaid's directive overrides its site config: `htmlLabels` (or the older
`flowchart.htmlLabels`; the root one wins when both are written) reading
`false`, `"false"`, `"null"` or `"0"` keeps SVG text. `safe: true` keeps
SVG text whatever either says. `flowchart.wrappingWidth`, a positive number
of px (default 200, Mermaid's), is where an HTML label line wraps (§6).
Every other diagram type ignores all three. Like every config member, the
diagram's stay in `config` and `toMermaid` prints them back.

**Only theme tokens reach the theme.** With no `theme` render option, a
config `theme` that is a name picks that theme; otherwise the config
members named like a theme token (`nodeFill`, `nodeText`, …, the keys of
`THEMES.default`) override it, and no other member does — Mermaid's
`themeVariables` names (`primaryColor`, …) are not this engine's tokens and
are ignored. Every override value, a host's included, becomes one
`--mm-*` custom-property value on the root's inline style, so a value that
could end that declaration or open another (`;`, `{`, `}`, `<`, a
backslash, a line break, `/*`, an unclosed quote, a `(` or `[` that does not
close in order, which opens a block no `;` ends) or is neither a string
nor a finite number is dropped and the theme keeps its own value. A config
token holding a `url()` other than a same-document `url(#id)` is dropped
too, under every render option, as a `style` statement's remote `url()` is;
a host's own `theme` option may name one.

## 4. The AST vocabulary

Every node is born from a constructor in `src/ast.js` with a fixed
member order (monomorphic; the structural hash is deterministic).

### 4.1 flowchart

```
{ direction, nodes[], edges[], subgraphs[], classDefs[], classes[], styles[], clicks[] }
```

| Shape | Members |
|-------|---------|
| node | `{ id, label, shape }` — shape ∈ rect, round, stadium, subroutine, cylinder, circle, doublecircle, diamond, hexagon, parallelogram, parallelogram_alt, trapezoid, trapezoid_alt, asymmetric |
| edge | `{ from, to, stroke, head, tail, length, label }` — stroke ∈ solid/thick/dotted; head/tail ∈ none/arrow/circle/cross; `length` preserved so the printer is a fixed point |
| subgraph | `{ id, label, direction, nodes[] }` |
| classDef / class / style | `{ name, styles }` / `{ node, name }` / `{ node, styles }` |
| click | `{ ids[], href, target, call, tooltip }` — one action: `href` (a link, never drawn) or `call` (`{ name, args[] }`, recorded and never run); `target` ∈ `_self`/`_blank`/`_parent`/`_top` after a link, else null; `tooltip` the author's text, else null |

`clicks` holds the `click` statements in source order, in the forms Mermaid's
flowchart grammar reads: `click A "url"` or `click A href "url"`, each with an
optional tooltip string and then an optional target, and `click A callback` or
`click A call callback(args)`, each with an optional tooltip string. A bare
callback reads as a `call` with no arguments, which is how Mermaid runs it,
and `toMermaid` prints a link with `href` and a callback with `call`. A line
that starts with `click ` and is none of these forms stays parse-accepted and
out of the tree, as every click line was before they were read; a tree written
before then lacks the member and reads as no clicks. A click's tooltip is what
a hydrated diagram shows for its node (§7), as text.

A flowchart declares at most 10,000 edges, counting the pairs a `&` group
expands to; a source that names more is a `MermaidParseError` on the line that
crosses the bound.

A node `id` is alphanumeric/underscore (plus Unicode letters); `-` and
`.` are **excluded** so an id can never swallow a following link
operator — `A-->B` parses as an edge, not as a node with id `A-`. This
is a deliberate parser-correctness deviation from upstream Mermaid,
whose grammar permits those characters in ids.

**Label text.** A node, edge or subgraph label holds its text without the
quotes around it, with `<br>` (`<br/>`, `<br />`) read as a newline — the
pipe form `A -->|"x"| B` and the inline form `A -- "x" --> B` alike, as
Mermaid reads both. A quoted label is one unit, so its delimiters are text:
`A["arr[0]"]` reads `arr[0]`, `A -->|"x|y"| B` reads `x|y` and
`A -- "a --> b" --> B` is one edge labelled `a --> b`. An inline label opens at
`--`, `==` or `-.` and a blank, as Mermaid opens edge text, so `A --- B --> C`
is two links. A `;` separates statements outside every label, where the
statement reader finds labels (a quote counts only where it opens one, so the
apostrophe in `A[it's] --> B; C --> D` is text and the `;` separates), and a `;`
inside a label is text, quoted or not (`A[a;b]`); a statement after a `;` may be
a keyword's (`A --> B; style A fill:#f00`, and `; end` ends the open subgraph,
a parse error with none open). The tree keeps everything else as written; one reading
of it (`src/label-text.js`), shared by the layout and both label renderers,
decides how it is drawn, and a state diagram's labels are read the same way
(a transition or description keeps its `<br/>` in the tree and breaks there):

- **Lines** break at a newline and at `<br>`.
- **Markdown strings.** A label wrapped in backticks — Mermaid's
  `` A["`**bold** and *italic*`"] `` — draws `**…**`/`__…__` bold and
  `*…*`/`_…_` italic, nesting as CommonMark pairs the delimiters (the
  innermost style wins, as Mermaid draws it), its lines trimmed and blank
  ones dropped. Other markdown (code spans, strikethrough, links) stays
  literal text, where Mermaid drops what it does not support. Mermaid reads
  only the quoted form as markdown; this tree keeps no quotes, so an
  unquoted `` A[`…`] `` reads as markdown here, and `toMermaid` prints every
  markdown string quoted. Mermaid also reads every state-diagram label as
  markdown; here only the backtick form is.
- **Entity codes.** Mermaid's decimal codes (`#35;` is `#`, `#9829;` is ♥)
  decode as an HTML parser reads the reference Mermaid makes of each: zero,
  a surrogate or a value past U+10FFFF is U+FFFD, and U+0080–U+009F is
  windows-1252. A code for a character XML cannot carry (a control other
  than tab, newline and return; U+FFFE; U+FFFF) is U+FFFD, and tab, newline
  and return draw as a space (Mermaid breaks the line at `#10;`). A named
  code (`#quot;` is `"`, `#amp;` is `&`) is the HTML standard's named
  reference of that name, read from `@jarenjs/core/text/entities`; a name the
  standard does not hold (`#nope;`, and `#x2665;`, which Mermaid reads as a
  name) stays as written. A code is decoded last, inside the text the line breaks
  and the emphasis left, so what it decodes to is always text — `#60;br#62;`
  never breaks a line, `#42;#42;` is never bold, and `#60;script#62;` is
  escaped like any label text (Mermaid decodes first and reads the result).

The other types' drawn text reads the same way, without markdown strings: a
sequence actor, message and note, and a class or ER panel's heading and rows,
break at `<br>` and decode their entity codes (`A->>B: I #9829; you #59; ok`
draws `I ♥ you ; ok`), and the layout sizes each for its lines — a message's
extra lines stack above its arrow and push what follows down. A sequence
block's label and a gantt title, section and task name, which are drawn on one
line, decode their codes and keep a `<br>` as text, as Mermaid draws a gantt
row. The tree keeps every code as written, so `toMermaid` prints it back.

### 4.2 sequence

```
{ participants[], statements[], autonumber }
```

`participants`: `{ id, label, kind }` (kind ∈ participant/actor).
`statements` is ordered; each is a `message`
(`{ kind, from, to, text, line, head, activation }`), a `note`
(`{ kind, placement, actors[], text }`), an `activate`/`deactivate`
(`{ kind, actor }`), or a `block`
(`{ kind:'block', blockType, branches:[{ label, statements[] }] }`) for
loop/opt/alt/par/critical/break.

### 4.3 class / er / state / pie

Class: `{ classes:[{ name, label, members[] }], relations[], clicks[] }`, a
click shaped as a flowchart's (§4.1) in the forms Mermaid's class grammar reads
— `click Name href "url"` with an optional tooltip and target, `click Name call
callback(args)` with an optional tooltip; the flowchart's bare forms are not
read, and a tree without `clicks` reads as none. ER:
`{ entities:[{ name, attributes[] }], relationships[] }`, an attribute being
`{ type, name, keys[] }` plus the `comment` that ended its line in quotes when
there was one (keys are `PK`, `FK`, `UK`, comma- or space-separated; `toMermaid`
prints them comma-separated, as Mermaid writes them). State:
`{ states:[{ id, label, parent? }], transitions:[{ from, to, label, event,
guard, effect, parent }] }` — a composite state's members carry its id as
`parent`, and a state is never its own ancestor (opening `state C {`
inside `C`, or declaring an ancestor inside its own descendant, leaves it
under the parent it already has); a transition's `label` is the verbatim
text after `:` (what renderers draw and `toMermaid` prints), and
`event`/`guard`/`effect` are its UML reading, parsed as
`event [guard] / effect` with every part optional: the first `[` opens
the guard (nesting counted), the effect starts at the first `/` after
it (or the first `/` at all when there is no guard), and a label that
fits no pattern — an unmatched `[`, or text between `]` and `/` — reads
whole as the event, which keeps plain labels meaning what they always
meant. Pie: `{ title, showData, slices:[{ label, value }] }`.

Gantt is `{ meta, rules, sections:[{ name, tasks[] }], domain }` and is
described in §4.4, because it is the one AST that carries a *resolved*
answer rather than only what the source said.

### 4.4 gantt — a resolved schedule

```
{ meta, rules, sections:[{ name, tasks[] }], clicks[], domain:{ start, end } }
```

`meta` holds the header lines **verbatim** (`title`, `dateFormat`,
`axisFormat`, `excludes`, `includes`, `inclusiveEndDates`, `topAxis`,
`tickInterval`, `weekday`, `weekend`, `todayMarker`), which is what keeps `printGantt` a
fixed point. `rules` holds the same directives *interpreted*:
`{ dateFormat, axisFormat, tick, weekStart, weekendStart, excludes,
includes, inclusiveEndDates, todayMarker }`, where `tick` is
`{ amount, unit }` or `null`, `weekStart`/`weekendStart` are ISO weekdays
(1 is Monday), `excludes` is `{ weekends, weekdays[], days[] }` with
`days` as day indexes from 1970-01-01, `includes` is `{ days[] }` in the
same indexes, and `inclusiveEndDates` is a boolean. A tree written
before `includes` and `inclusiveEndDates` existed lacks both members and
reads as no exceptions and exclusive ends. Several `excludes` lines (or
several `includes` lines) are one list, as in Mermaid, so `meta` holds
their terms joined by a space on a single line.

A task is
`{ name, info, id, flags, start, end, duration, after, line }`. `info`
is the raw metadata string the printer emits; the rest is the schedule.
`start`/`end` are epoch milliseconds and the interval is **half-open**,
so `end` is the first instant the task no longer occupies — except a
milestone, which is the instant `start === end`. `flags` is the subset
of `done`, `active`, `crit`, `milestone` in that order. `domain` is the
half-open span every task falls inside, and it is what layout scales
against.

`clicks` holds the `click` statements in source order, each
`{ ids[], href, call, line }`: the task ids it names, the URL as written (or
`null`) and the call (or `null`) as `{ name, args[] }`. A tree written before
they were read lacks the member and reads as no clicks.

The AST stays geometry-free and plain JSON: no compiled closure and no
coordinate crosses this boundary. `layout/gantt.js` re-compiles the axis
pattern from `rules`, once per diagram.

#### The three grammars

A Gantt header speaks three pattern languages and **none of them is
Unicode LDML**, so each gets its own tokenizer and each token is mapped
individually onto the core vocabulary (`src/parser/gantt-grammar.js`):

| Directive | Grammar | Example |
|---|---|---|
| `dateFormat` | dayjs `customParseFormat` (moment's spelling) | `DD-MM-YYYY` |
| `axisFormat` | d3-time-format (strftime) | `%Y-%m-%d` |
| `tickInterval` | `^([1-9]\d*)(millisecond\|second\|minute\|hour\|day\|week\|month)$` | `1week` |
| a task duration | `^(\d+(?:\.\d+)?)([Mdhmswy]\|ms)$` | `3d`, `1.5w`, `2M` |

Handing `YYYY` straight to the core compiler would be a silent lie —
LDML's `YYYY` is the *week-numbering* year, so `YYYY-MM-DD` read as LDML
answers 2019 for `2018-12-31`. Note also that moment's `m` is a minute
while strftime's `%m` is a month: one shared table would mis-read half
of every diagram.

`axisFormat` is only ever written, never read, and it is written on
the UTC clock. Each specifier is its own LDML pattern, compiled on its
own, because adjacent tokens of one letter merge into a wider one. The
ISO week number `%V`, the ISO weekday `%u` and the quarter `%q` are core
tokens (`ww`, `E`, `Q`), and `%f` is the millisecond followed by `000`,
as in d3. LDML has no token for the other four, so they are computed
from the instant as d3 computes them: the ISO week-based year `%G` (four
digits) and `%g` (two), taken from `isoWeekOfYear`, `%Q` as whole epoch
milliseconds, and `%s` as epoch seconds rounded down, so -1.5 s is `-2`.
So `%G-W%V` labels 2021-01-03 `2020-W53` and 2024-12-30 `2025-W01`. The
week-based year is derived for each tick, so the AST and the core parts
record keep their one calendar year. Three supported specifiers still
write something other than d3's UTC formatter: `%Z` writes `Z` where d3
writes `+0000`, and `%Y`/`%y` write year -5 as `0005`/`95` where d3
writes `-0005`/`-05` (`%G`/`%g` keep d3's sign). `dateFormat` is dayjs'
grammar, not strftime, so none of these eight can reach a task's date;
dayjs' own epoch tokens `X` and `x` are read there as instants and its
`Q`, `w` and `ww` are declined, both as the next paragraphs say.
*Upgrade: `%f`, `%g`, `%G`, `%q`, `%Q`, `%s`, `%u` and `%V` were refused
by name. Two adjacent specifiers were merged into one wider token, so
`%y%Y` wrote its two years in the wrong order and `%m%m` asked for a
month name.*

A `dateFormat` of exactly `X` or `x` reads each date as an **instant**:
`X` counts seconds and `x` milliseconds from 1970-01-01T00:00:00Z, and
the task date is that instant, on the UTC clock like every other date
here. This is dayjs' `customParseFormat` as Mermaid calls it, strictly:
dayjs writes the instant back and compares the text, so the one spelling
read is the one it writes, an integer with no sign but a minus, no
leading zero and no `-0`. `dateFormat X` reads `1704067200` as
2024-01-01T00:00Z and `-86400` as 1969-12-31T00:00Z, and refuses `1.5`,
`01`, `+5` and `1e3` as not a date in `X` (non-strict dayjs reads the
fraction; Mermaid's strict call does not). The instants run from
0000-01-01T00:00Z, the first a date in any `dateFormat` reads here, to
the last a JavaScript date holds. dayjs reads neither token anywhere
else — its token table has no `X` or `x`, so `YYYY-MM-DD X` or `[at ]X`
reads nothing for the count — and this engine refuses either beside any
other token or literal on the `dateFormat` line; a bracketed `[x]` stays
a literal. An `excludes` or `includes` term in `X` names the UTC day
that holds its instant, as a term with a time does in any other
`dateFormat` (Mermaid compares a term with the probed instants
themselves). Mermaid's own start reading differs, see divergence 10.
*Upgrade: `dateFormat X` and `dateFormat x` were refused by name; they
now read every task date as an instant, so a diagram that used them
parses where it was an error.*

The quarter `Q` and the week numbers `w` and `ww` are **declined**, each
a `JM` error naming its reason. A week number names a date only under a
week-year rule (which week of a year is the first, which weekday starts
it). dayjs' rule is the locale week of its `weekOfYear` plugin; the core
date kernel keeps RFC 3339 strings and epoch milliseconds, not a date
type with a calendar attached (`packages/core/docs/DATES.md`), derives
only the ISO week from a date, and its parser reads no week back.
Mermaid itself loads no dayjs week plugin, so its own strict read of a
week token never yields a date. A quarter names three months rather than one: dayjs reads it as
the quarter's first month (`YYYY Q` reads `2024 3` as 2024-07-01), a
field the core parser does not keep. A diagram writes the date instead.

An **unsupported** token is a `JM` error naming the token and the
reason, not a literal passed through. The vendored conformance table —
every documented token of the Mermaid version this engine tracks, marked
supported or refused with its reason, plus the provenance of where it
was read — is `test/mermaid/fixtures/gantt-grammar.json`, and
`test/mermaid/gantt.test.js` pins the code against it in both
directions.

Both directions is a closed loop, so the table is also checked against
the shipped chunk it was read from: dayjs' parse table is inlined there,
and every token Mermaid really accepts must appear. A token in neither
list is not refused — it becomes literal text, and then the diagram's
own dates are what look wrong. `w`, `ww` and `Y` reached the tree that
way; the week numbers are now declined by name (above) and `Y` is the
signed variable-width year core's `y` already spells.

#### Task forms and working days

The field-count rule is Mermaid's own: one field is an end, two are a
start and an end, three add an explicit id in front, and the four flags
lead. `after <id …>` starts a task at the latest end of those ids;
`until <id …>` ends it at the earliest start of those. Ids may be
forward references — resolution is a topological pass — and a cycle, a
missing id, a duplicate id, a reversed span and an empty non-milestone
span are all refused with the offending line.

`excludes` removes whole days: `weekends` (the `weekend` day and the one
after it, saturday by default), weekday names, and dates written in the
document's own `dateFormat`. An end derived from a *duration* is pushed
out one day per excluded day it crosses; an end written as an explicit
*date* is the author's answer and is never pushed. The probes are the
instants `start + k days`, so a task starting Friday noon and lasting a
day ends Monday noon. Days are UTC days. This is not a holiday service:
a schedule skips exactly what its own `excludes` lines list.

`includes` is the exception list: a date written there (in the
document's `dateFormat`) is a working day whatever `excludes` says, so it
wins over `weekends`, a weekday name and an excluded date alike, and it
does not matter which of the two directives comes first. It gives days
back and removes none, so it changes nothing while nothing is excluded,
and an included day is not shaded on the timeline. As in Mermaid, only a
date can match: any other term on the line (a weekday name, `weekends`,
the `10:00` of a time, a word) is ignored, and so is a trailing `%%`
comment, which `excludes` and `inclusiveEndDates` accept as well.

`inclusiveEndDates` takes no argument. With it, an end written as a date
names the *last day worked*: the half-open `end` is the day after it, so
`2024-01-01, 2024-01-03` occupies the first, second and third. A
duration and `until` are exact instants and keep their meaning, and the
extra day is added before anything that follows reads the end, so an
`after` successor starts a day later too. The date end stays "the
author's answer": the extra day is not pushed past `excludes` either.

#### Click statements

`click <ids> href "<url>"` and `click <ids> call <name>(<arguments>)` are
read as Mermaid's lexer and grammar read them (the vendored table lists
every form and every reject, and was run through the shipped parser). The
ids are one word, separated by commas; `href` and `call` may both appear, in
either order, each once, and a `%` comment may follow. The three words are
matched in any case. A line that starts with `click` and does not read as a
click statement is a `JM` error on its line unless it carries the `:` that
separates a task's name from its data (a colon outside every double-quoted
run and every parenthesis): that line is a task row, so `Click the button :
a3, 2024-01-09, 1d`, `Click on href : a3, ...` and `Click to call (now) : a3,
...` stay tasks, and a bare `click` or `click a1` is the error.

A click binds by task id wherever it is written (before the task, after it,
in another section), and an id no task has binds nothing. When several
statements carry an `href` for one task the last one wins.

**A link is drawn through the allow-list the package already applies to
links.** The layout gives each row `href`, `null` or the URL that
`sanitizeHref` passes (http and https URLs, `mailto:`, a fragment, a
protocol-relative URL such as `//cdn.example/x`, a root-relative path and a
dot-relative path) percent-encoded for the attribute, and the
renderer wraps the row's label and shape in one `<a href class="mm-gantt-click">`
inside its group; the group also gains `mm-gantt-clickable`. A URL the
allow-list refuses (`javascript:`, `data:`, `vbscript:`, `file:`, any other
scheme, a bare relative `page.html`) leaves the task without a link, and an earlier safe link on the
same task does not come back. The tree keeps the URL as written, so a host
that draws from the tree instead of the scene must filter it with the
exported `sanitizeHref`.

**A call is data.** The tree records the name and the argument strings
(split as Mermaid splits them, so none written is `[]`, where Mermaid would
pass the task id when it runs the call); nothing looks the name up, binds it
or runs it, at any config, and the layout and the renderer ignore it
completely: no class, no handler, no attribute, and a document with and
without it renders byte for byte alike. Mermaid's default level binds
nothing either, so a document that renders there renders here; only its
loose level, which runs a global function chosen by the diagram's text, has
no counterpart. A host that wants the call reads `clicks` and decides what
the name means.

#### The two switches that live in the config

`topAxis` and `displayMode: compact` live in the diagram's config in
Mermaid — `gantt.topAxis` and `gantt.displayMode`, set by an `%%{init}%%`
directive or by the front matter's `config` — and so they do here: they
arrive in layout as the document's `config.gantt` and never enter the AST,
so a document with and without them parses to the same tree. (The one
exception is a bare `topAxis` header line, below.) A top-level
front-matter `displayMode: compact` is Mermaid's shorthand for
`config.gantt.displayMode`; it wins over that member, and an init
directive wins over both. `toMermaid` writes
the config back as an init directive, so the switch survives a round
trip.

`displayMode` must be exactly `compact` (`Compact` is not). `topAxis` is
a truthiness test, as in Mermaid, so `true` and the string `"false"` both
turn it on and `false`, `0` and `""` leave it off.

**Compact mode** packs each section's tasks into the fewest rows. They
are taken in start order, source order breaking a tie, and each goes into
the first row whose last task has ended by its start, so a task that
starts the instant another ends shares its row. The end compared is the
task's resolved `end`, after `excludes` has pushed it. Each section packs
from its own first row, and its height is its row count times the row
height. A row now holds several tasks, so a name no longer has a line of
the label column to itself: it is centred on its bar when it fits,
otherwise it starts after the bar, and when that would run past the right
edge it ends before the bar, and only then is it cut, to the room left of
the bar. A name that fits is drawn whole. In the scene, a row's `lane` is its row
within its section, `labelAnchor` is `start`, `middle` or `end`, and the
scene's `compact` says which mode laid it out.

**`topAxis`** adds a second row of date labels, with the same ticks and
the same labels, and an axis line under it. Mermaid draws its axis below
the rows and `topAxis` adds one above; this engine has always drawn its
axis above the rows, so with the switch on both engines show a row on each
side, and with it off the engines differ in which side the single row is
on. In the scene, `bottomAxis` is `null`, or `{ y, labelY }`, and the
height grows to hold the row.

#### Ten deliberate divergences from Mermaid

1. **No clock.** Mermaid starts an undated first task *today*. This
   engine has no clock anywhere (`packages/core/docs/DATES.md`, "there is no `now`"),
   so a schedule with no dated anchor is a `JM` error rather than a
   diagram that means something different tomorrow. In practice only the
   first task needs a date. For the same reason `todayMarker` is kept
   in `meta` and never drawn.
2. **No silent literals** — an unsupported pattern token is refused by
   name, where Mermaid passes it through as text.
3. **No guessed dependencies** — Mermaid falls back to today for an
   `after` naming an unknown id; this engine refuses.
4. **A row named like a directive stays a row** — Mermaid reads every
   line that starts with `includes` as that directive and drops the
   task, so `includes the API docs : a1, 2024-01-05, 3d` vanishes
   there. Here a line that starts with `includes` or `inclusiveEndDates`
   and holds a colon that is not inside a time (`10:00`) is a task row,
   which is what such a line was before the words were directives. A
   line that starts with `topAxis` and holds such a colon is a task row
   too, where Mermaid fails on it.
5. **A bare `topAxis` header line is honoured.** Mermaid's grammar
   recognises the word and then calls a database method that does not
   exist (`yy.TopAxis is not a function`), so the line fails there. Here
   it is a no-argument directive like `inclusiveEndDates`: it stays in
   `meta` (so the printer keeps it) and turns the second axis on, exactly
   as `gantt.topAxis` in the config does; anything after the word is
   ignored. This engine accepts a line Mermaid rejects, and renders what
   the line asks for.
6. **Compact sections keep their own rows and their own order.** Mermaid
   groups the tasks of a compact chart by section *name* and walks the
   groups in JavaScript key order, so two sections with the same name pack
   together and an integer-looking name (`section 2024`) jumps in front of
   the others. Here a section is a place in the document: it packs on its
   own and keeps its position.
7. **A click `href` goes through the package's allow-list.** Mermaid sends
   the URL through the sanitize-url package, which turns `javascript:` into
   `about:blank` and leaves the task a link, and keeps a relative `page.html`;
   here the forms `sanitizeHref` passes draw a link and every other URL draws
   none.
8. **A click `call` is never run and never drawn.** It is recorded in the tree
   (see above); Mermaid's loose level calls the page's global function of that
   name, and its default level binds nothing but still marks the task
   clickable.
9. **A click binds by id wherever it stands, and a line that starts with the
   word but carries a task's colon is a task row.** Mermaid applies a click when it reads the
   line, so one written before its task has no effect, and `Click the button :
   a3, 2024-01-09, 1d` fails its parse.
10. **`dateFormat X` reads every date as seconds.** Mermaid reads a start
   date that is only digits as milliseconds under both `x` and `X`, before
   dayjs sees it, so `dateFormat X` with `a, 1704067200, 1d` starts on
   1970-01-20 there; a negative start and every end go through dayjs and
   count seconds. Here a start and an end are both read as dayjs reads
   them, so that task starts on 2024-01-01.


### 4.5 Secondary types, and the pie renderer

mindmap, gitGraph, journey, timeline, quadrantChart, requirement
parse-accept into `{ diagram, lines[] }` and render an honest "not yet
laid out" placeholder — counted in the coverage scorecard.

A **pie** parses into its AST (§4.3) and is drawn by a renderer the host
injects: `diagramToVnode(doc, { renderers: { pie } })`, the option every
render entry point carries. The renderer is called with the pie AST, the
resolved theme and the document hash, and answers the SVG vnode. The pie
engine lives in `@jarenjs/charts`, which ships the one to inject —
`mermaidPieRenderer` from `@jarenjs/charts/transforms/mermaid-adapter` —
so this engine imports no other component. Without a renderer a pie
renders the same placeholder, its second line reading "parsed — no pie
renderer was injected".

## 5. The bidirectional round trip

`toMermaid(doc)` is a **canonical** printer (one closure per diagram
type) and the reverse of `parseMermaid`. The normative contract:

> **`parseMermaid(toMermaid(doc))` deep-equals `doc.ast`** for the
> fully-modeled types (flowchart, sequence).

The flowchart printer emits in a fixed order — node declarations (AST
order) → subgraph membership → edges → classDef/class/style → click — and it is
that ordering which makes node order and edge order a fixed point on the
round trip. Subgraphs, however, round-trip **structurally, not as a
deep-equal fixed point**: they emit their members by bare id and a
re-parse reconstructs membership, so the shape survives but the strict
`nodes[]` ordering of a subgraph is not guaranteed to be `===`-identical
to the original.

The state printer keeps the order of `states` (layout reads it): when the
plain spelling would introduce the states in another order, it declares every
state first. The class printer writes a member that holds a `}` or starts with
`%%` as a `Name : member` line, because a body ends at its first `}` and drops
comment-looking lines; the pie printer writes a label's line break as `<br/>`
and a value as a plain decimal. The flowchart printer writes a markdown string
in quotes (`` ["`**a**`"] ``, `` |"`b`"| ``), which Mermaid needs to read it as
one, and an edge label in the pipe form, quoted where it holds a `|` or a `;` or
starts or ends with a quote or a space (`` |"semi;colon"| ``), so every label
reads back as the same graph. Mermaid has no escape inside quotes, so a label
that no quoting can hold prints one character as its decimal entity code, which
draws as that character and reads back as the code: `"` as `#34;` where a label
holds both quote kinds beside a `;` or its own closer, and the closer (`|`, `]`,
`)`, `}`) where a label holds it beside a link operator (`a --> b|c` prints
`` |"a --> b#124;c"| ``).

The printer is canonical, not verbatim: it does not preserve source
whitespace or comments. Two round-trip modes coexist:

- **verbatim**, via the raw source stored in the Markdown fence `value`
  while a node is *untransformed*;
- **canonical**, via `toMermaid` once the AST changes or the engine is
  used standalone.

Because there is no per-plugin `toMarkdown` hook, a JSLT-transformed
diagram round-trips through `toMarkdown` only when its fence `value` is
refreshed with `toMermaid(newDoc)` — `refreshMermaidFence` is that
primitive.

### 5.1 Semantic projections

The geometry-free AST doubles as a domain model, and six JSLT
stylesheets in [`stylesheets/`](../stylesheets/) project it both ways —
plain data documents, no code:

| stylesheet | from → to |
|---|---|
| `state-to-workflow.jslt.json` | state DiagramDocument → executable machine (`@jarenjs/flow`'s jaren-fsm superset shape) |
| `workflow-to-state.jslt.json` | machine document → state AST (print with `toMermaid`) |
| `state-to-statechart.jslt.json` | compound state DiagramDocument → jaren-fsm 0.2 (`compileStatechart`) |
| `statechart-to-state.jslt.json` | statechart document → state AST, preserving compound parents, initials and finals |
| `flowchart-to-dag.jslt.json` | flowchart DiagramDocument → jaren-dag **skeleton** (every node a `task` stub named by its id; edge labels become `port`s verbatim) |
| `dag-to-flowchart.jslt.json` | jaren-dag document → flowchart AST |

The forward state projection maps the parsed UML parts: `event` and
`guard` carry over when present, and an `effect` becomes
`effects: [{ "run": <effect text> }]` — the effect label **is** the
registry name by convention. The reverse composes the label from the
machine's parts and stays consistent with the parser by construction.

The compound projection uses `parent` on states as well as transitions;
the parser records arbitrary nesting depth and the printer retains transition
order while reopening compound scopes when necessary. A scope's unlabelled
`[*]` entry supplies its `initial`; an unlabelled edge to `[*]` declares its
source terminal. Missing or ambiguous initials, a terminal with other outgoing
transitions, or labelled pseudo-state edges refuse at statechart compilation.
The 0.1 projection keeps its original flat behavior. Statechart history,
parallel types, internal/external distinctions, delays, completion/eventless
triggers and state entry/exit effects have no lossless spelling in this
projection: author and retain those in JSON. The reverse is a display
projection outside the compound/initial/final subset, not a serialization
format for a full statechart.

The dag projection renders each node kind as a fixed flowchart shape:

| kind | shape |
|---|---|
| `input` | stadium |
| `output` | doublecircle |
| `const` | circle |
| `query` | rect |
| `jslt` | round |
| `task` | subroutine |

Edge decorations print into the edge label as `port` / `port · select`
(joined with ` · `).

**Lossiness is documented, not hidden.** Diagrams are pictures of
machines; the document is the truth. A structured (non-string) guard
prints as the `[…]` placeholder; an effect prints its `run` name only
(multiple effects join with `, `), dropping any `with`; a structured
edge `select` prints as `…`. Round-tripping is exact for string guards
and bare run names, and deliberately lossy beyond that. Division of
labor: a cyclic flowchart **projects** to a dag skeleton without
complaint — acyclicity is `compileDag`'s job (`JF0016`), not the
projection's.

## 6. Layout & metrics (informative)

Layout is a separate pure pass (`layoutDiagram`) producing a
`PositionedDiagram` scene graph. Node/label sizes come from
`measureText`, a per-codepoint advance-width table for a default
sans-serif — an approximation, no `getBBox`, no DOM. Flowchart layout is
a compact dagre-lite (longest-path ranks, banded coordinates, straight
border-clipped edges); sequence layout resolves lifelines, message
y-advance, activation bars, notes and block frames. Geometry is
deterministic, so golden-JSON tests catch drift.

**State diagrams lay out through the flowchart engine** via an adapter
(`layoutState`), not a second algorithm: states become rounded nodes,
transition `label`s become edge labels verbatim, and the `[*]`
pseudo-states become synthetic `__start`/`__end` nodes (a fixed-size
filled `statedot` and an empty-labeled `doublecircle` ring — shapes
only the adapter produces; flowchart source cannot spell them).

**HTML labels are measured, not asked for.** With HTML labels (§3), every
node and edge label line wider than `flowchart.wrappingWidth` wraps at its
spaces, greedily, as a browser wraps Mermaid's HTML label at its maximum
width; a word wider than the width keeps its line, as a browser lets it
overflow. The lines are measured with the same advance table as SVG text
and each box is sized for them, so a label that does not wrap lays out
exactly as it does as SVG text, and a wrapped one makes a narrower,
taller box in the same rank and order. No layout is read from a DOM — not
in SSR, not in a browser — so the geometry is the same wherever it is
computed. The scene then carries `htmlLabels: true` and the wrapped
`lines` of every node and edge label — a line is its text, or a markdown
line's runs (`{ text, type }`, type `normal`/`strong`/`em`), wrapped word by
word with each word keeping its style (a word ends only at a space, so one whose
style changes inside it, `**three**four`, stays on one line); the SVG-text scene
has neither. Every
label is measured as it is read (§4.1): decoded, one line per break, and a
bold run in the table's bold advance.

**Subgraph frames lie inside the canvas.** A frame reaches past its members
by its padding, and above them by its title band, so a subgraph holding a
node of the first rank or the first column would start above or left of the
canvas; the layout then moves the whole diagram until every drawn frame keeps
the canvas margin, as the right and bottom edges always did.
Composite states stay flattened in v1, their recorded `parent` not yet
drawn as a cluster. `compileMermaid(source).toLayout()` exposes the
scene as a cached projection — reference-equal on repeated calls, null
for types without a geometric layout, laid out with the options the
document is drawn with (`layoutDiagram(doc, options)`) — so an editor
hit-tests against the boxes it sees without re-running layout.

## 7. Rendering

`diagramToVnode` turns a `PositionedDiagram` into a tagged-array SVG
vnode rooted at `['svg', …]`, which the `@jarenjs/view` patcher creates
in the SVG namespace (an HTML label's `foreignObject` content in the HTML
one). It is synchronous, complete and **error-safe**: a
parse/layout failure returns an error vnode, never throws. `toSvgString`
is `renderToString` of that vnode — a valid standalone SVG with no
browser.

**Stable identity for editors.** In flowchart and state output, every
node group carries `data-id="<AST node id>"` and every edge group
carries `data-edge="<index>" data-from="<id>" data-to="<id>"`, where
the index is the edge's AST position — which is also its docPath tail,
so a click maps to a document member without translation. These are
plain data props on the vnodes: SSR emits them, event delegation reads
them, and the state renderer's root additionally carries the
`mm-state` class for theming.

Every other type that draws something a reader can point at writes the same
markers (`src/render/marks.js`): a node is a group with the class `mm-node`
and `data-id`, its name in an `mm-label` text, and an edge an element with the
class `mm-edge`, `data-edge`, `data-from` and `data-to`, its label in an
`mm-edge-label` text. A sequence actor's head and foot boxes are both nodes of
the participant id and a message an edge (`data-edge` its position among the
messages); a class's or an entity's box is a node of its name and each row of
the relations box an edge (its position among the relations); a gantt row is a
node of its task id and a dependency connector an edge from the prerequisite
to the dependent task (its position among the connectors). A pie, a
placeholder and an error draw none. A node a `click` gave tooltip text carries
it as the text of its first child `<desc>`, which draws nothing and is escaped
like any label, so the author's text never becomes markup and the standalone
SVG stays well-formed whatever it holds. The opt-in tooltips
(`mermaidPlugin({ tooltips: true })`) read exactly these markers.

**HTML labels.** A flowchart or state diagram the host renders with
`htmlLabels: true` (§3) draws each node label, edge label and subgraph title as a
`foreignObject` holding an XHTML `div` that carries the label's marker
class (`mm-label`, `mm-edge-label`, `mm-cluster-label`) and one block `div`
per line the layout measured (§6). The `foreignObject` covers the node box
(the edge label's background, a 20px band at the top of a subgraph frame);
the text is centered in it at 14px with line height 1.2 — the advance
table's, where Mermaid's HTML uses 1.5 — never wrapped again by the browser
and free to overflow rather than clip when the host's font runs wider than
the table. Its color is the theme's `--mm-node-text` (`--mm-edge-label-text`
for an edge), a custom property every root declares, or the `color` an
author's style names. The text is escaped like SVG text and nothing in it
is read as markup: it is read as SVG text reads it (§4.1), a `<br>` breaking
the line, a markdown string's runs drawn in `strong`/`em` (in SVG text, a
`tspan` with `font-weight="bold"`/`font-style="italic"` inside its line), and
an entity code decoded to text. No void element is written, so the standalone SVG stays
well-formed XML — but only a renderer that draws `foreignObject` (a
browser) shows its labels; a rasterizer or an SVG viewer that does not
shows none, so a host producing output for one leaves `htmlLabels` unset.
The node and edge markers are unchanged, and the tooltips read an HTML
label's lines as they read SVG text's.

The `@jarenjs/view` safe policy drops `foreignObject` and everything in it,
so an HTML-label diagram rendered through it loses its labels. That is why
the host, not the diagram, enables them (§3): a host that renders through
the safe policy and passes nothing keeps SVG text whatever a diagram's
config says. `safe: true` in the same render options keeps every label SVG
text even when `htmlLabels: true` is passed — the output is then the
SVG-text output, byte for byte.
