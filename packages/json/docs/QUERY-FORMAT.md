# The Jaren JSON Query Format

**Version 0.1 — Specification**

Module: `@jarenjs/json/query`. This document is the language contract; the
package [README](../README.md) carries the guided tour and the engine's
internals are described in [ARCHITECTURE](../ARCHITECTURE.md).

> **Naming note (non-normative).** "Jaren JSON Query format" is a working name
> and is used consistently throughout this document. The obvious short name
> "JSON Query" collides with the independent jsonquery.org project; final
> naming/branding is an open question and is deliberately not settled here.

---

## 1. Introduction

### 1.1 What this language is

The Jaren JSON Query format is a declarative query-and-transformation language
for JSON documents. Its semantics are those of **XQuery 3.1** — sequences,
FLWOR expressions, effective boolean value, existential comparisons — but its
surface syntax is **JSON itself**: a query document is a JSON value, the way an
XSLT stylesheet is an XML document. Navigation leaves are **RFC 9535 JSONPath**
strings, and the degenerate query is a bare JSONPath string.

Semantics follow XQuery 3.1 except where a numbered deviation (D1–D7, §11)
says otherwise.

A non-normative XQuery *text* front-end (`parseXQuery(text)` producing a query
document) is a planned compatibility layer; only the JSON format is specified
here. The JSON query document is the canonical language.

### 1.2 Conformance and normative language

The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**,
**SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **MAY**, and **OPTIONAL** in this
document are to be interpreted as described in RFC 2119.

Two conformance roles exist:

- A **producer** emits query documents. A producer MUST emit documents that
  are structurally valid per §12's JSON Schema and semantically valid per this
  specification.
- A **consumer** (compiler + evaluator) MUST accept every valid query document
  and MUST reject invalid documents with the compile errors of §10; it MUST
  raise the runtime errors of §10 under the conditions specified there.

### 1.3 Terminology

- **Query document** — the top-level JSON value handed to the compiler (§4).
- **Expression** — any JSON value in expression position, interpreted per the
  encoding rules of §3.
- **Phrase** — an object whose keys are all `$`-prefixed and which matches one
  of the closed vocabulary shapes of §§4–8 (operator phrases, the FLWOR
  phrase, quantifier phrases, the version envelope).
- **Path** — a string expression that is an RFC 9535 JSONPath query, absolute
  or variable-rooted (§5).

---

## 2. Data model

### 2.1 Items and sequences

1. An **item** is any JSON value: `null`, a boolean, a number, a string, an
   array, or an object. There is no node identity beyond JSON value structure;
   arrays and objects are items like any other.
2. Numbers are IEEE 754 double-precision floats (**D1**). There is no separate
   integer, decimal, or float type. Integer-valued positions and lengths are
   doubles with integral values.
3. Every expression evaluates to a **sequence** of zero or more items.
   Sequences are **flat** and **ordered**: a sequence never contains another
   sequence. Combining sequences concatenates them.
4. The **empty sequence** `()` contains no items. The empty sequence is *not*
   the same thing as `null`: `null` is an item, and a sequence containing
   `null` has length 1.
5. A sequence of exactly one item is identified with that item ("singleton ≡
   item"). A literal `42` and a one-item sequence containing `42` are
   indistinguishable.
6. The **input document** a query is applied to MUST be an item — that is, a
   JSON value. An implementation is NOT required to verify this (a deep check
   would cost a full walk per call), so a non-JSON value passed in may simply
   flow through as an opaque item. It MUST, however, reject a *missing*
   document (JavaScript `undefined`) with `JQ2011`: a host API that spends
   the absent value on the empty sequence would otherwise answer "empty" for
   a query whose existence test says otherwise.

### 2.2 Effective boolean value (EBV)

Several constructs (`$where`, `$if`, `$and`, `$or`, `$not`, `$satisfies`)
reduce a sequence to a boolean, its **effective boolean value**. The EBV of a
sequence MUST be computed as follows, in order:

| Sequence | EBV |
|---|---|
| empty sequence | `false` |
| singleton `false` / `true` | the boolean itself |
| singleton number `n` | `false` if `n` is `0`, `-0`, or `NaN`; otherwise `true` |
| singleton string `s` | `false` if `s` is empty; otherwise `true` |
| singleton `null` | `false` |
| singleton array or object | `true` (**D3** — XQuery raises FORG0006 here) |
| any sequence of two or more items | runtime error `JQ2003` |

Note that D3 makes the EBV total over all singletons; only multi-item
sequences are erroneous.

---

## 3. Encoding rules

Three rules assign a meaning to every JSON value in expression position. They
are exhaustive: every JSON value is either an expression or a compile error.

### 3.1 Rule 1 — objects

Partition an object's keys by whether they start with `$` (U+0024):

1. **All keys `$`-prefixed → operator phrase.** The object MUST match one
   shape from the closed phrase vocabulary (§§4, 6, 7, 8). An unknown `$`-key
   is compile error `JQ0002`; a known key with the wrong value shape, arity,
   or key combination is compile error `JQ0003`.
2. **No key `$`-prefixed → map constructor.** Each key is a literal member
   name; each value is evaluated as an expression. The result is a single
   object item. Member value expressions follow the content rules of §3.4.

   ```json
   { "title": "$b.title", "inStock": true, "tags": ["new", "sale"] }
   ```

   constructs an object with members `title` (value of the path `$b.title`),
   `inStock` (literal `true`), and `tags` (a constructed array, Rule 3).
3. **Mixed → compile error `JQ0001`.** An object with both `$`-prefixed and
   plain keys is never valid.

   ```json
   { "title": "$b.title", "$where": true }
   ```

   is a compile error (`JQ0001`).

To construct an object whose member names start with `$` or are computed at
runtime, use the escape hatches of §3.5 (`$const`, `$map`).

An empty object `{}` has no `$`-prefixed key and is therefore a map
constructor: it constructs the empty object.

### 3.2 Rule 2 — strings

A string starting with `$` (U+0024) is a **query expression**; any other
string is a **literal string**. The forms, checked in order:

1. **Absolute path.** `$` alone, or a string starting with `$.`, `$[`, or
   `$..`, MUST be a complete RFC 9535 JSONPath query. Its root `$` is the
   input document. (RFC 9535 queries begin with `$` by grammar, so the sigil
   costs nothing.) Examples: `"$"`, `"$.store.book[*]"`,
   `"$..price"`, `"$['odd key']"`.
2. **Variable-rooted path.** `$name`, where *name* matches
   `[A-Za-z_][A-Za-z0-9_]*`, optionally followed by RFC 9535 *segments*:
   `"$b"`, `"$b.price"`, `"$b['odd key'][0]"`, `"$b[?@.x > 1]"`. The grammar
   is RFC 9535 with the root identifier `$` replaced by the variable
   reference. The path is evaluated with the variable's value as its root.
3. **Literal string escape.** A string starting with `$$` denotes the literal
   string obtained by dropping exactly one leading `$`: `"$$price"` is the
   string `"$price"`, `"$$$x"` is the string `"$$x"`. The escape applies only
   to the two leading characters; no other unescaping occurs.
4. **Literal string.** Any string not starting with `$` is itself:
   `"hello"` is the string `"hello"`.

A string starting with `$` that matches none of forms 1–3 (e.g. `"$9foo"`,
`"$ x"`), or that matches a head form but is not a grammatically valid path
(e.g. `"$.store["`), is compile error `JQ0004`.

Inside the bracketed filter expressions embedded in a path (either form),
`@` and `$` keep their RFC 9535 meanings — the current node and the *input
document* root respectively. **Query variables are not visible inside path
filters**; a filter that needs another variable is a cross-variable predicate
and belongs in `$where` (§6.4). See §5.2 for the two filter dialects.

### 3.3 Rule 3 — scalars are literals

Numbers, booleans, and `null` denote themselves: `42`, `true`, `null` are
literal items (singleton sequences).

### 3.4 Rule 3, continued — arrays are array constructors

An array in expression position is an **array constructor**. Each element is
evaluated in order, and the resulting sequences are concatenated per XQuery
sequence flattening into the members of one new array item: an element
evaluating to a sequence of N items contributes N members; an element
evaluating to the empty sequence contributes none.

```json
[1, "$.store.book[*].price", { "$seq": [2, 3] }]
```

Against a store with four book prices, this constructs a single 7-element
array: `1`, the four prices, `2`, `3`.

This flattening is a property of the sequence data model, not of the array
constructor alone; it applies in every expression position where a sequence can
flow. A **map-constructor member value** is the one position that cannot flatten
— a JSON member holds exactly one value — so it takes the single-value
cardinality rule instead: a member value that evaluates to the empty sequence
**omits the member**, a singleton becomes the member's value, and a value of two
or more items is runtime error `JQ2001`. To embed an array *as a value* without
evaluation, use `$const` (§3.5.1); to bind one without iteration, use `$let`
(§6.3).

### 3.5 Escape hatches

#### 3.5.1 `$const` — quote

```json
{ "$const": v }
```

evaluates to `v` verbatim, as a single item. Nothing inside `v` is evaluated:
strings starting with `$` stay as written, objects with `$`-keys are plain
data, arrays are not flattened. `v` MAY be any JSON value.

```json
{ "template": { "$const": { "$for": "kept verbatim", "price": null } }, "label": "$$price" }
```

constructs `{ "template": { "$for": "kept verbatim", "price": null }, "label": "$price" }`.

#### 3.5.2 `$map` — general map constructor

```json
{ "$map": [[keyExpr, valueExpr], ...] }
```

constructs one object from a list of key/value expression pairs. Use it for
computed member names and for names that start with `$`. For each pair, in
order:

- *keyExpr* MUST evaluate to a single string; any other result (empty
  sequence, non-string, multi-item sequence) is runtime error `JQ2004`.
- *valueExpr* is evaluated and taken as the member value under §3.4's
  member-value cardinality: an empty result **omits the pair**, a singleton is
  the value, and two or more items are runtime error `JQ2001`.
- Later pairs win on duplicate keys — but because an omitted (empty-valued) pair
  is never written, an earlier pair for the same key **survives** a later pair
  for that key whose value is the empty sequence.

Each pair MUST be an array of exactly two expressions (`JQ0003` otherwise).
An empty pair list constructs the empty object.

```json
{ "$let": { "prefix": "col_", "book": "$.store.book[0]" },
  "$return": { "$map": [
    [{ "$concat": ["$prefix", "title"] }, "$book.title"],
    [{ "$concat": ["$prefix", "price"] }, "$book.price"]
  ] } }
```

constructs `{ "col_title": ..., "col_price": ... }`.

---

## 4. Query documents

### 4.1 Top level

A query document is either:

1. a **bare expression** — any expression per §3. In particular a bare
   JSONPath string is a complete query (the degenerate case), and so is a
   bare scalar; or
2. the **version envelope** phrase:

   ```json
   { "$query": "0.1", "$expr": <expression> }
   ```

   Both keys are REQUIRED and no other key is permitted (`JQ0003`).

### 4.2 Versioning

The version identifier for this specification is the string `"0.1"`. A
missing envelope implies the consumer's current version. A `$query` value
that is not a version string the consumer implements — including non-string
values and unknown future versions — is compile error `JQ0006`.

The envelope is only recognized at the top level of a query document; an
object with `$query`/`$expr` keys in any other expression position is an
unknown operator phrase (`JQ0002`/`JQ0003`).

---

## 5. Paths

### 5.1 Path semantics

A path (absolute or variable-rooted, §3.2) evaluates to the sequence of the
nodes' values selected by the RFC 9535 query, **in document order** as defined
by RFC 9535 (children of an object in member order, of an array in index
order; descendant traversal per RFC 9535 §2.5.2). That node sequence then
flows through the query as an ordinary XQuery sequence.

A variable-rooted path evaluates its segments against each item of the
variable's bound sequence, in order, concatenating results. For the common
case of a `$for` variable the binding is a single item.

**Singular queries** (RFC 9535 singular query: name and index selectors only)
are statically known to evaluate to zero or one item; consumers MAY exploit
this, and later work uses it for static cardinality checks.

An absolute path in any expression position reads from the one input
document; there is no context-item drift — `$` is always the document root.

> **Footgun (variable-rooted filters).** A filter selector filters the
> *children* of each node it is applied to (RFC 9535 §2.3.5). So a filter
> written directly against a `$let`/`$for` variable tests that item's members,
> not the item itself. Given `{"$let": {"books": "$.store.book[*]"}}`, the path
> `"$books[?@.price > 20]"` applies the filter to the *members* of each book
> object and asks each member for a `.price` child — no member has one, so every
> book contributes the empty sequence and the whole path is empty. To filter the
> books themselves, place the predicate one level up, where the books are the
> children being filtered — `"$.store.book[?@.price > 20]"` — or iterate with
> `$for` and test in `$where` (§6.4).

### 5.2 The two filter dialects

Two boolean mini-languages coexist in this format, and both keep the exact
semantics of their own standard:

1. **Inside a path's `[?...]` filter**, RFC 9535 semantics apply unchanged —
   including the special absent-value `Nothing`, where `Nothing == Nothing`
   is **true** for two empty singular-query results.
2. **At query level** (`$where`, `$eq`, ...), XQuery semantics apply —
   comparisons are existential over sequences, so a comparison in which
   either side is the empty sequence is **false** (§8.4).

Worked example. Input:

```json
{ "a": [ { "n": 1 } ] }
```

The item in `a` has neither member `b` nor member `c`.

- Path dialect: `"$.a[?@.b == @.c]"` **selects the item** — both sides are
  empty nodelists of singular queries, i.e. `Nothing == Nothing`, which
  RFC 9535 defines as true.
- Query dialect:

  ```json
  { "$for": { "x": "$.a[*]" },
    "$where": { "$eq": ["$x.b", "$x.c"] },
    "$return": "$x" }
  ```

  returns the **empty sequence** — `$x.b` and `$x.c` are both empty, an
  existential comparison over empty sequences finds no witnessing pair, so
  `$eq` is false.

Neither dialect is wrong; they answer different questions. Producers SHOULD
choose the dialect deliberately when absent members are possible.

---

## 6. The FLWOR phrase

### 6.1 Shape and clause order

A FLWOR phrase is an operator phrase containing `$fold`, `$for` and/or
`$let`, plus optional clauses, plus the REQUIRED `$return`:

| Key | Value | Presence |
|---|---|---|
| `$fold` | one-member accumulator binding (§6.9) | at least one of `$fold`, `$for`, `$let` |
| `$for` | binding object (§6.2) | at least one of `$fold`, `$for`, `$let` |
| `$let` | binding object (§6.3) | at least one of `$fold`, `$for`, `$let` |
| `$as` | schema assertion object (§6.8) | OPTIONAL |
| `$where` | expression | OPTIONAL |
| `$groupby` | binding object (§6.5) | OPTIONAL |
| `$orderby` | key spec or array of key specs (§6.6) | OPTIONAL |
| `$count` | variable name string (§6.7) | OPTIONAL |
| `$return` | expression | REQUIRED |

The clauses apply in **fixed semantic order regardless of their order in the
JSON document** (**D7**):

```
$fold → $for → $let → $as → $where → $groupby → $orderby → $count → $return
```

JSON key order is not interoperable — several ecosystems (e.g. Go maps)
neither preserve nor guarantee it — so this format MUST NOT give key order
semantic weight anywhere, and does not.

Exotic clause interleavings (a `$let` between two `$for`s, a `$where` before
a `$for`, multiple `$where`s) are expressed by **nesting** FLWOR phrases,
which is standard XQuery practice anyway:

```json
{ "$for": { "a": "$.store.book[*]" },
  "$return": { "$let": { "p": "$a.price" },
               "$where": { "$gt": ["$p", 10] },
               "$return": "$a.title" } }
```

The FLWOR phrase evaluates to the concatenation of the `$return` results over
the surviving tuple stream, in tuple order — unless the phrase has a `$fold`
clause (§6.9), in which case it evaluates to the final accumulator and
`$return` names the accumulator's next value instead of an output item.

### 6.2 `$for` — iteration bindings

```json
"$for": { name: source, ... }
```

Each *name* MUST match `[A-Za-z_][A-Za-z0-9_]*` (`JQ0003` otherwise). Each
*source* is either an expression or the extended binding form below. A `$for`
binding evaluates its source and iterates the resulting item sequence,
binding *name* to one item per tuple.

**Auto-iteration of arrays (D4).** When an item produced by the source is an
array, `$for` unpacks it into its members — one level only — and iterates
those. This is the ergonomic default for the JSON data model, where `[*]`
already produced values, not nodes. To bind an array *as a value*, use `$let`
or `{"$const": [...]}`. Objects are NOT auto-iterated; iterate an object's
values with a `[*]` path segment, or its member pairs with the `$entries`
operator (§8.9).

**Multiple bindings** nest left-to-right in document key order, exactly like
consecutive XQuery `for` clauses, and **may be correlated**: a later source
may reference variables bound earlier in the same `$for` object.

> **Interop caveat.** Correlation is the one place where the *relative order*
> of keys inside a single binding object matters. Producers on
> key-order-hostile stacks SHOULD emit one binding per phrase, nesting
> phrases, instead of relying on multi-key binding objects.

**Extended binding form** — a source written as an object with an `$in`
member iterates `$in` like a plain source, with options:

```json
{ "$in": expr, "$at": "posName" }
```

binds *posName* to the **0-based** (D6) position of the current item within
the iterated sequence. `$in` is the only REQUIRED key (so a bare
`{"$in": expr}` is just the long spelling of the plain form); *posName* MUST
be a valid variable name. The two remaining options — `$allowing-empty` and
the `$window` family — are §6.10.

```json
{ "$for": { "b": { "$in": "$.store.book[*]", "$at": "i" } },
  "$count": "n",
  "$return": { "index": "$i", "row": "$n", "title": "$b.title" } }
```

### 6.3 `$let` — sequence bindings

```json
"$let": { name: expr, ... }
```

Binds each *name* to the **full sequence** its expression evaluates to — no
iteration, no array unpacking. Name rules, document-key-order evaluation, and
correlation rules are identical to `$for` (later `$let` sources see earlier
`$let` variables of the same object). The extended `$in`/`$at` form is not
available in `$let` (`JQ0003`).

Binding the same variable name twice within one FLWOR phrase — in one binding
object (where JSON parsers permit duplicate keys), across the phrase's `$for`
and `$let` objects, as an `$at` name, or in `$groupby` (as a new key name) —
is compile error `JQ0007`. Rebinding a name from an *enclosing* phrase is
ordinary shadowing and is allowed.

### 6.4 `$where` — tuple filter

```json
"$where": expr
```

Evaluates *expr* once per tuple and keeps the tuples whose **EBV** (§2.2) is
true. Cross-variable predicates (joins) belong here, not in path filters
(§3.2, §5.2).

### 6.5 `$groupby` — grouping

```json
"$groupby": { name: keyExpr, ... }
```

XQuery 3.1 group-by semantics:

- Each *keyExpr* is evaluated per tuple; each *name* becomes a
  **grouping-key variable**, bound in every subsequent clause to that group's
  key value (a singleton per group). A *keyExpr* MUST evaluate to the empty
  sequence or a single item; a two-or-more-item key is runtime error `JQ2001`.
  An **empty key is allowed** and groups with the other empty keys.
- Tuples with equal key combinations form one group. Key equality is **deep
  structural JSON equality** (`equalsJson`-grade), with numbers compared
  mathematically. Unlike `$eq` item equality (§8.4), grouping treats **`NaN` as
  equal to itself** (the XQuery grouping rule; §8.9's `$distinct` and `$sort`
  cite the same relation).
- Every other variable bound in the phrase is **rebound to the sequence** of
  its values across the group's tuples, in tuple order.
- The tuple stream after `$groupby` has one tuple per group, in order of
  **first appearance** of each group's key combination in the incoming
  tuple stream.

*name* MUST be a valid variable name, distinct from every other variable
bound in the phrase (`JQ0007`).

```json
{ "$for": { "b": "$.store.book[*]" },
  "$groupby": { "genre": "$b.category" },
  "$return": { "genre": "$genre",
               "count": { "$count": "$b" },
               "avg": { "$avg": "$b.price" } } }
```

Here, inside `$return`, `$genre` is one key value and `$b` is the sequence of
that genre's books.

### 6.6 `$orderby` — ordering

```json
"$orderby": keySpec
"$orderby": [keySpec, ...]
```

A *keySpec* is either an expression (shorthand for ascending, empty-least) or
the explicit form

```json
{ "$key": expr, "$dir": "asc" | "desc", "$empty": "least" | "greatest",
  "$collation": "name" }
```

with `$key` REQUIRED and `$dir` (default `"asc"`), `$empty` (default
`"least"`) and `$collation` OPTIONAL.

`$collation` names a **registered pure compare function**
(`options.collations`, a trusted host capability like `options.functions`,
§8.12) applied to this key's *string* comparisons — the natural-language
orders (`Intl.Collator('nl').compare`, say) that the format's default
code-point order (§8.9) deliberately does not build in. Number keys keep
numeric order; an unregistered name is compile error `JQ0010`. Registered
collations appear in `query.dependencies`/`query.explain()` (§8.12), so a
saved rule declares the collations it needs.

- An array value of `$orderby` is **always a list of key specs**, ordered
  major to minor, and MUST NOT be empty. Consequently a *single* key spec is
  never written as a bare array: an array-constructor sort key (a runtime
  error under the key-type rules anyway) MUST be wrapped as
  `{"$key": [...]}`. The schema enforces this reading.
- The sort is **stable**.
- Each key expression is evaluated per tuple. A key value MUST be the empty
  sequence or a single number or string; within one comparison pair the two
  key values MUST be both numbers or both strings — numbers compare
  mathematically, strings by **Unicode scalar values** (code point order).
  Comparing any other combination (number with string, or a key that is a
  boolean, `null`, array, object, or multi-item sequence) is runtime error
  `JQ2005`. A `NaN` key is a number: the comparator is total over `NaN`, ordering
  it **equal to itself and less than every other number**, then falling through
  to the next key on ties (§8.9's `$sort` cites this same rule).
- Empty key sequences sort per `$empty`: `"least"` (default) places them
  first ascending / last descending; `"greatest"` the reverse.

```json
{ "$for": { "b": "$.store.book[*]" },
  "$orderby": [ { "$key": "$b.price", "$dir": "desc", "$empty": "greatest" }, "$b.title" ],
  "$return": "$b.title" }
```

### 6.7 `$count` — tuple numbering

```json
"$count": "name"
```

Binds *name* (a valid variable name string) to the **0-based** (D6) index of
the tuple in the stream *after* `$where`, `$groupby`, and `$orderby` have
applied. See §6.2 for an example.

Collision note: as a FLWOR clause, `$count`'s value is a **name string**; as
an operator (§8.7), `$count` is a single-key object whose value is an
expression. The two are structurally unambiguous — the clause occurs only
among other FLWOR keys with `$return` present; the operator phrase is exactly
one key.

### 6.8 `$as` — schema assertions on bindings

```json
"$as": { name: schema, ... }
```

Numbered after `$count` for historical reasons; in the fixed clause order of
§6.1, `$as` occupies the slot **between `$let` and `$where`**.

Each member names a variable bound by **this phrase's** `$for` (including
`$at` position names) or `$let`, and pairs it with a **JSON Schema literal**
(§8.11): a JSON value taken **verbatim** — never interpreted as a query
expression, so JSON Schema's `$`-prefixed keywords (`$ref`, `$defs`, ...) do
not collide with Rule 1. A name not bound by the phrase's `$for`/`$let` is
compile error `JQ0005`. Each schema is compiled once, at query compile time,
by the consumer's type-test compiler (`JQ0008` when none is installed,
`JQ0009` when it rejects the schema — see §8.11).

Per tuple, after the `$for`/`$let` bindings are established and before
`$where` applies:

- a `$for` or `$at` variable is validated as its one bound **item**;
- a `$let` variable is validated **per item of its bound sequence** (the
  empty sequence passes vacuously — the schema sees items, never the
  sequence itself, §8.11).

The first failing item is runtime error `JQ2008`, naming the variable. `$as`
never drops tuples — it asserts; use `$valid` in `$where` (§8.11) to filter
instead.

```json
{ "$for": { "b": "$.store.book[*]" },
  "$as":  { "b": { "type": "object", "required": ["title", "price"] } },
  "$return": "$b.title" }
```

### 6.9 `$fold` — the accumulator clause

```json
"$fold": { name: initExpr }
```

`$fold` turns the phrase from a *map* into a **reduction**. It binds exactly
one accumulator variable (a second member is `JQ0003`):

- *initExpr* is evaluated **once**, in the phrase's **enclosing** scope,
  before the tuple stream starts. It therefore cannot reference this phrase's
  own `$for`/`$let` bindings — such a name is free, and resolves as an
  external (§9) rather than as the binding.
- *name* is in scope from `$let` onward — in `$let`, `$where`, `$groupby`,
  `$orderby` and `$return` — but **not** in `$for` sources, which are
  iterated once and must not depend on a value that changes per tuple.
- For each surviving tuple, `$return` is evaluated and the accumulator is
  **rebound to its result**. `$return` names the accumulator's next value,
  not an item of the output.
- The phrase evaluates to the **final accumulator**. If no tuple survives,
  that is the initial value.

*name* counts as a binding of this phrase for the duplicate rule (`JQ0007`).
Because the accumulator is a binding rather than a lambda parameter, this
gives the language a general fold without giving the JSON encoding a way to
spell a **function value** — folds, running totals and pointer walks are
expressible; passing a function to an operator still is not.

`$fold` composes with every other clause. With `$orderby` the reduction runs
over the *sorted* tuples; with `$groupby` it updates once per group; `$where`
selects which tuples update it at all.

```json
{ "$fold": { "total": 0 },
  "$for": { "b": "$.store.book[*]" },
  "$where": { "$lt": ["$b.price", 10] },
  "$return": { "$add": ["$total", "$b.price"] } }
```

sums the prices of the cheap books. Because `$get` (§8.9) is a real dynamic
lookup, a fold over a runtime path is a pointer walk:

```json
{ "$fold": { "cur": "$.doc" },
  "$for": { "seg": "$.path[*]" },
  "$return": { "$get": ["$cur", "$seg"] } }
```

resolves `$.path` — a sequence of member names and array indexes — against
`$.doc`, one segment per tuple.

### 6.10 `$allowing-empty` and window clauses

Two further options of the extended `$for` binding form (§6.2).

**`$allowing-empty`** makes a binding **outer-join-style**: when the source
would yield no tuple at all, the clause emits exactly **one** tuple with the
variable bound to the **empty sequence**, so the enclosing tuple survives.

```json
{ "$in": expr, "$allowing-empty": true }
```

The condition is "yields no tuple", not "the sequence was empty" — an item
that is an empty array contributes no members under D4 unpacking (§6.2) and
so also triggers it. When the binding also has `$at`, that tuple's position
is **-1**: every real position is a non-negative 0-based one (D6), so -1 is
the only value free to mean "no position".

Note the source is what must be empty. Because a path filter's `$` is the
input document and never a query variable (§3.2), a *correlated* source is
written as a nested phrase:

```json
{ "$for": { "b": "$.store.book[*]",
            "r": { "$in": { "$for": { "x": "$.ratings[*]" },
                            "$where": { "$eq": ["$x.isbn", "$b.isbn"] },
                            "$return": "$x" },
                   "$allowing-empty": true } },
  "$return": { "title": "$b.title", "stars": "$r.stars" } }
```

keeps every book, rated or not; an unrated book's `stars` member is omitted
because an empty member value omits the member (§3.4).

**Windows** iterate consecutive *runs* of the item stream instead of single
items:

```json
{ "$in": expr, "$window": "tumbling" | "sliding", "$size": n, "$step": m, "$at": "w" }
```

`$size` is REQUIRED with `$window` and MUST be a positive **integer literal**,
as MUST `$step` when present; they are not expressions, because a width that
varied per tuple could not be compiled into a specialized loop. `$size`/`$step`
without `$window`, or `$window` without `$size`, is `JQ0003`. The variable
binds the window's items **as a sequence** (not an array item); `$at` binds
the 0-based window number.

A window starts at item 0 and every `$step` items thereafter; `$step`
defaults to `$size` for `tumbling` and to `1` for `sliding`. The two kinds
differ only in what happens at the end of the stream:

- **`tumbling`** *partitions* the stream — every item belongs to exactly one
  window — so a short final window IS emitted; dropping it would silently
  lose data.
- **`sliding`** is a moving view of fixed width, so a short window is not one
  of them: only full-width windows are emitted.

```json
{ "$for": { "w": { "$in": "$.readings[*]", "$window": "sliding", "$size": 3 } },
  "$return": { "$avg": "$w" } }
```

is a 3-point moving average; the same document with `"tumbling"` and no
`$step` averages disjoint blocks of three, including a final block of one or
two if the stream does not divide evenly.

---

## 7. Quantifier phrases

```json
{ "$some":  { name: expr, ... }, "$satisfies": expr }
{ "$every": { name: expr, ... }, "$satisfies": expr }
```

XQuery `some/every ... satisfies`. The binding object follows `$for` rules
(names, document-key-order nesting, correlation, D4 array unpacking) except
that the extended `$in`/`$at` form is not available (`JQ0003`). Both keys are
REQUIRED.

For each binding tuple, the EBV (§2.2) of `$satisfies` is computed:

- `$some` is `true` iff at least one tuple satisfies; `false` over an empty
  tuple stream.
- `$every` is `true` iff every tuple satisfies; `true` over an empty tuple
  stream.

Evaluation MUST short-circuit ("early exit"): `$some` MAY stop at the first
satisfying tuple, `$every` at the first failing one; a runtime error in a
tuple after the deciding tuple is then not raised.

```json
{ "$every": { "b": "$.store.book[*]" }, "$satisfies": { "$exists": "$b.title" } }
```

```json
{ "$let": { "books": "$.store.book[*]" },
  "$return": { "$some": { "b": "$books" },
               "$satisfies": { "$gt": ["$b.price", 20] } } }
```

---

## 8. Operators

### 8.1 Vocabulary and conventions

Every operator is a **single-`$`-key object** (the phrases of §§4, 6, 7 and
the two-key quantifier shapes are the only exceptions). The vocabulary is
**closed**: an object whose single `$`-key is not listed in this section is
compile error `JQ0002`. Wrong argument shapes and arities are `JQ0003`.

Signature notation: `expr` is any expression; `[a, b]` is a JSON array of
exactly two expressions; `[e, ...]` is variadic; `?` marks an optional
trailing argument. "Cardinality" describes the *runtime* sequence each
argument position accepts; argument positions are structurally always
expressions (per-position runtime rules are enforced by the evaluator with
`JQ2xxx` errors, not by the schema).

Unless a definition below says otherwise, an operator's result is exactly
one item. Operators whose semantics come from XQuery 3.1 Functions and
Operators keep that reference in their definition; F&O behavior is adapted
to the JSON data model per the deviations of §11 (notably D1 numbers and
D6 0-based positions).

The JSON-Schema-as-type-system layer defines `$valid` and `$assert` (§8.11)
and the FLWOR clause `$as` (§6.8); no keys remain reserved in this version.

### 8.2 Sequences

| Operator | Signature | Result |
|---|---|---|
| `$seq` | `{"$seq": [e, ...]}` | XQuery comma: evaluate each element, concatenate all results into one flat sequence. `{"$seq": []}` is the empty sequence. |
| `$exists` | `{"$exists": e}` | `true` iff `e`'s result is non-empty (XQuery `fn:exists`). |
| `$empty` | `{"$empty": e}` | `true` iff `e`'s result is empty (XQuery `fn:empty`). |

```json
{ "$if": [ { "$exists": "$.store.bicycle" },
           { "$seq": ["$.store.bicycle.color", "$.store.bicycle.price"] } ] }
```

### 8.3 Conditional

| Operator | Signature | Result |
|---|---|---|
| `$if` | `{"$if": [cond, then, else?]}` | EBV of *cond*; on `true` evaluates *then*, on `false` evaluates *else*. A missing *else* means the empty sequence. Only the taken branch is evaluated. |

Arity 2–3 (`JQ0003` otherwise). Example above.

### 8.4 Comparisons — `$eq $ne $lt $le $gt $ge`

Signature: `{"$eq": [left, right]}` etc., arity exactly 2.

These are **general comparisons** in the XQuery sense (the `=` family):
existentially lifted over sequences. `{"$op": [L, R]}` is `true` iff **some**
item `l` of `L`'s result and **some** item `r` of `R`'s result satisfy the
item comparison; otherwise `false`. Consequences:

- Over empty sequences the result is `false` — there is no witnessing pair.
  Contrast this with `Nothing == Nothing` inside path filters, which is true;
  see §5.2, "The two filter dialects".
- `$ne` is existential too: `{"$ne": [L, R]}` is true iff some pair differs —
  it is NOT the negation of `$eq` on multi-item sequences. Use
  `{"$not": {"$eq": [L, R]}}` for the negation.

**Item comparison rules:**

- `$eq` / `$ne` use **deep structural JSON equality** (**D2**): two items are
  equal iff they are structurally identical JSON values; numbers compare
  mathematically (`1` equals `1.0`; `NaN` equals nothing, `-0` equals `0`);
  arrays memberwise in order; objects by key set and per-key values,
  key order irrelevant.
- `$lt $le $gt $ge` compare numbers with numbers (mathematically) and strings
  with strings (Unicode scalar value order). For **any other item pair**
  (number vs string, booleans, `null`, arrays, objects) the item comparison
  is simply **false** for that pair — not an error — and contributes no
  witness.

```json
{ "$and": [
  { "$eq": ["$.store.bicycle.color", "red"] },
  { "$or": [ { "$lt": ["$.store.bicycle.price", 400] }, { "$not": false } ] },
  { "$ne": [1, 2] }, { "$le": [1, 1] }, { "$gt": [2, 1] }, { "$ge": [2, 2] }
] }
```

### 8.5 Arithmetic — `$add $sub $mul $div $idiv $mod`, `$neg`

Signatures: `{"$add": [a, b]}` etc., arity exactly 2; `{"$neg": a}` unary
(the value is the operand expression itself, not a one-element array).

Operand rules (each operand, after evaluation):

- empty sequence → the operator's result is the **empty sequence** (XQuery);
- a singleton number → used as is;
- a singleton non-number, or a multi-item sequence → runtime type error
  `JQ2001` (XPTY0004-shaped).

All arithmetic is IEEE double arithmetic (**D1**):

- `$div` by zero follows IEEE 754: `Infinity`, `-Infinity`, or `NaN` — the
  XQuery *double* division semantics, not the decimal FOAR0001 error.
- `$idiv` is **truncating division** (quotient rounded toward zero to an
  integral double); `$idiv` or `$mod` with a zero divisor is runtime error
  `JQ2002`. Only a **zero divisor** errors: an `Infinity` or `NaN` *dividend*
  over a finite non-zero divisor is not an error — both operators keep IEEE
  double behavior (`Math.trunc` of the quotient, `%` for `$mod`) and yield
  `NaN`, in keeping with D1's IEEE arithmetic.
- `$mod` takes the sign of the dividend (XQuery `mod` semantics).
- `$neg` is unary minus.

```json
{ "$seq": [ { "$add": [1, 2] }, { "$sub": [3, 1] }, { "$mul": [2, 4] },
            { "$div": [1, 0] }, { "$idiv": [7, 2] }, { "$mod": [7, 2] },
            { "$neg": "$.store.bicycle.price" } ] }
```

### 8.6 Logic — `$and $or $not`

| Operator | Signature | Result |
|---|---|---|
| `$and` | `{"$and": [e, ...]}` (≥ 1) | `true` iff every operand's EBV is true. |
| `$or` | `{"$or": [e, ...]}` (≥ 1) | `true` iff some operand's EBV is true. |
| `$not` | `{"$not": e}` | negated EBV of `e` (XQuery `fn:not`). |

Operands are reduced by EBV (§2.2) left to right with **short-circuit**
evaluation: `$and` stops at the first false, `$or` at the first true;
operands after the deciding one are not evaluated and cannot raise errors.
Example in §8.4.

### 8.7 Strings

**String parameters.** Every argument of the operators in this section
(except where a definition says otherwise) MUST evaluate to the empty
sequence — read as `""`, the F&O `xs:string?` convention — or to a single
string; a singleton of any other type, or a sequence of two or more items,
is runtime error `JQ2001`. `$concat` and `$string-join` additionally cast
their *item* operands per the `$string` table (§8.10). All results are
single items.

| Operator | Signature | Definition |
|---|---|---|
| `$concat` | `{"$concat": [e, ...]}` (≥ 0) | Variadic concatenation. Each operand is cast to string per `$string` (§8.10); an empty-sequence operand contributes `''`. `{"$concat": []}` is `""`. |
| `$string-join` | `[seq, sep?]` (1–2) | Concatenates the items of *seq*, each cast to string per `$string`, separated by *sep* (a string parameter, default `""`). An empty *seq* yields `""` (F&O `fn:string-join`). |
| `$substring` | `[str, start, len?]` (2–3) | The code points of *str* at 0-based (**D6** — deviation from F&O's 1-based positions) positions `p` with `round(start) ≤ p` and, when *len* is given, `p < round(start) + round(len)` (F&O `fn:substring` bounds; `round` rounds half toward +∞). *start*/*len* MUST each be a single number (`JQ2001`); a `NaN` bound selects nothing. |
| `$contains` | `[str, sub]` | `true` iff *str* contains *sub* (`fn:contains`; every string contains `""`). |
| `$starts-with` | `[str, prefix]` | `true` iff *str* starts with *prefix* (`fn:starts-with`). |
| `$ends-with` | `[str, suffix]` | `true` iff *str* ends with *suffix* (`fn:ends-with`). |
| `$upper` | `{"$upper": e}` | Unicode default uppercase (`fn:upper-case`). |
| `$lower` | `{"$lower": e}` | Unicode default lowercase (`fn:lower-case`). |
| `$string-length` | `{"$string-length": e}` | Length in Unicode scalar values (code points), `fn:string-length`. Empty → `0`. |
| `$normalize-space` | `{"$normalize-space": e}` | Strips leading and trailing whitespace (space, tab, CR, LF) and collapses every internal whitespace run to one space (`fn:normalize-space`). |
| `$match` | `[input, pattern]` | `true` iff *pattern* matches **all** of *input* (anchored, the RFC 9535 `match()` behavior). |
| `$search` | `[input, pattern]` | `true` iff *pattern* matches a substring of *input* (RFC 9535 `search()`, XQuery `fn:matches`). |
| `$replace` | `[input, pattern, replacement]` (exactly 3) | Replaces every non-overlapping match of *pattern* in *input* with *replacement* (`fn:replace`). *replacement* is inserted **literally** — there are no capture-group references (I-Regexp guarantees no capture semantics). |

Regular expression operators use **I-Regexp (RFC 9485)** syntax — the same
interoperable regex dialect RFC 9535 uses — not XSD regular expressions
(**D5**). I-Regexp has no flags argument, hence `$replace`'s fixed arity 3.
A *pattern* that is not a syntactically valid I-Regexp makes `$match` and
`$search` evaluate to `false` (the RFC 9535 rule for nonconforming
patterns), but is runtime error `JQ2001` in `$replace` (the F&O
`err:FORX0002` condition — a replacement cannot silently do nothing). A
`$replace` *pattern* that matches the zero-length string (e.g. `"a*"`) is
also `JQ2001` (F&O `err:FORX0003`). Pattern *type* errors remain `JQ2001`
in all three operators per the string-parameter rule above.

```json
{ "$seq": [ { "$concat": ["a", "b"] },
            { "$string-join": ["$.store.book[*].title", ", "] },
            { "$substring": ["hello", 1, 3] },
            { "$contains": ["hello", "ell"] },
            { "$starts-with": ["hello", "he"] },
            { "$ends-with": ["hello", "lo"] },
            { "$upper": "abc" }, { "$lower": "ABC" },
            { "$string-length": "abc" }, { "$normalize-space": "  a  b  " },
            { "$match": ["abc", "a.c"] }, { "$search": ["abc", "b"] },
            { "$replace": ["abc", "b", "x"] } ] }
```

### 8.8 Aggregates — `$count $sum $avg $min $max`

Each is unary: `{"$count": e}` etc. Aggregates consume their operand
sequence **as-is**: an item that is an array counts as *one* item — D4
unpacking is a `$for`/quantifier binding rule, not a sequence rule. (So
`{"$count": {"$const": [1, 2, 3]}}` is `1`, while iterating the same value
with `$for` yields three tuples.) See §6.7 for the `$count`
clause/operator collision note.

| Operator | Empty sequence | Definition |
|---|---|---|
| `$count` | `0` | The number of items in the operand's result (`fn:count`). |
| `$sum` | `0` | The sum of the items (`fn:sum`). Every item MUST be a number (`JQ2001`). |
| `$avg` | empty | The arithmetic mean of the items (`fn:avg`). Every item MUST be a number (`JQ2001`). |
| `$min` | empty | The least item (`fn:min`). Items MUST be all numbers or all strings (`JQ2001` otherwise, including mixed); numbers compare mathematically, strings by Unicode scalar values. A `NaN` item makes the result `NaN` (F&O). |
| `$max` | empty | The greatest item (`fn:max`), same rules as `$min`. |

### 8.9 Sequence operators — `$distinct $reverse $sort $head $tail $subsequence $index-of $range $get $entries $from-entries`

| Operator | Signature | Definition |
|---|---|---|
| `$distinct` | `{"$distinct": e}` | The distinct items of the operand, in first-occurrence order (`fn:distinct-values` adapted to D2 deep equality). Equality is the **grouping key relation** of §6.5: deep structural equality with `NaN` equal to itself and `-0` equal to `0` — `$distinct` and `$groupby` always agree. |
| `$reverse` | `{"$reverse": e}` | The operand's items in reverse order (`fn:reverse`). |
| `$sort` | `{"$sort": e}` | The operand's items sorted ascending by value (`fn:sort`, natural order only — key-based sorting is `$orderby`'s job). Items MUST be all numbers or all strings; anything else, or a mix, is runtime error `JQ2005` (the `$orderby` key-type rules). `NaN` orders per §6.6: equal to itself, less than every other number. The sort is stable. |
| `$head` | `{"$head": e}` | The first item, or empty (`fn:head`). |
| `$tail` | `{"$tail": e}` | Every item but the first; empty for operands of one or zero items (`fn:tail`). |
| `$subsequence` | `[seq, start, len?]` (2–3) | The items of *seq* at the 0-based (D6) positions selected by the `$substring` bound rules (§8.7, F&O `fn:subsequence`): `round(start) ≤ p`, and `p < round(start) + round(len)` when *len* is given. *start*/*len* MUST each be a single number (`JQ2001`). |
| `$index-of` | `[seq, item]` | The 0-based (D6) positions in *seq* of the items deep-equal to *item*, as a sequence, in order (`fn:index-of`). Equality is the `$eq` item relation (D2) — `NaN` matches nothing. *item* MUST be exactly one item (`JQ2001`). |
| `$range` | `[start, end]` | The integers from *start* to *end* **inclusive** (the XQuery `to` operator). Either operand empty → empty; *start* > *end* → empty. A non-integral or non-number operand is `JQ2001`. A result of more than 2³² items is runtime error `JQ2007` (resource guard). |
| `$get` | `[target, key]` | Dynamic lookup, the runtime counterpart of a path leaf: an object *target* with a string *key* yields the member value or empty; an array *target* with an integer *key* yields the element at that 0-based (D6) index — a negative index counts from the end, like the RFC 9535 index selector — or empty. **Every other combination** (wrong type pairing, non-integral index, empty or multi-item operands) is simply the empty sequence, never an error. |
| `$entries` | `{"$entries": e}` | The member-pair counterpart of a `[*]` path segment (which yields values only): each OBJECT item of the operand contributes one `{"key": name, "value": v}` pair per member, in member order; non-object items contribute nothing, and an empty operand yields the empty sequence. `$from-entries` is the inverse; the `$map` constructor (§3.5.2) is the fixed-arity form for computed keys. |
| `$from-entries` | `{"$from-entries": e}` | The inverse of `$entries`: assembles ONE object from the operand's `{"key": name, "value": v}` items, in sequence order — later pairs win on duplicate keys, exactly like the `$map` constructor. Items without a string `key` contribute nothing; a pair missing its `value` member reads as `null`; an empty operand constructs the empty object. |

Combined example (also exercises the aggregates of §8.8):

```json
{ "$seq": [ { "$count": "$.store.book[*]" }, { "$sum": "$.store.book[*].price" },
            { "$avg": "$.store.book[*].price" }, { "$min": "$.store.book[*].price" },
            { "$max": "$.store.book[*].price" }, { "$distinct": "$.store.book[*].category" },
            { "$reverse": "$.store.book[*].title" }, { "$sort": "$.store.book[*].price" },
            { "$head": "$.store.book[*]" }, { "$tail": "$.store.book[*]" },
            { "$subsequence": ["$.store.book[*]", 1, 2] },
            { "$index-of": ["$.store.book[*].category", "fiction"] },
            { "$range": [1, 5] }, { "$get": ["$.store.bicycle", "color"] } ] }
```

### 8.10 Types and casts

**Type predicates.** Unary `{"$is-string": e}`, `$is-number`,
`$is-boolean`, `$is-null`, `$is-array`, `$is-object` — `true` iff `e`'s
result is a **singleton** of that type. The empty sequence and sequences
of two or more items yield `false`, never an error — these are cheap
tests, not assertions.

**Casts.** Unary `{"$string": e}`, `{"$number": e}`, `{"$boolean": e}`.
`$string` and `$number` propagate the empty sequence (empty → empty); a
multi-item operand, or a singleton the cast table rejects, is runtime
error `JQ2001`.

| Cast | Definition |
|---|---|
| `$string` | string → itself; number → its shortest JavaScript serialization (`String(n)`; `NaN`/`Infinity` serialize by name); `true`/`false` → `"true"`/`"false"`; `null` → `"null"`; array or object → `JQ2001`; empty → empty. (`$concat`/`$string-join` cast items by this table, with an explicit `''` for empty operands — §8.7.) |
| `$number` | number → itself; string → the number it spells **iff** it is a syntactically valid JSON number (RFC 8259 grammar — no leading `+`, no bare or trailing `.`, no whitespace, no `Infinity`/`NaN`), else `JQ2001`; `true`/`false` → `1`/`0`; `null`, array, object → `JQ2001`; empty → empty. |
| `$boolean` | The **EBV** (§2.2) as an operator: empty → `false`, singletons per the EBV table (D3 included), a sequence of two or more items → `JQ2003`. |

| Operator | Signature | Definition |
|---|---|---|
| `$coalesce` | `{"$coalesce": [e, ...]}` (≥ 1) | The result of the first operand whose result is non-empty, else empty. Evaluation is lazy: operands after the deciding one are **not evaluated** and cannot raise errors. |
| `$default` | `[e, fallback]` | `e`'s result if non-empty, else *fallback*'s — sugar for `$coalesce` of exactly two. |

```json
{ "$seq": [ { "$is-string": "abc" }, { "$is-number": 1 }, { "$is-boolean": true },
            { "$is-null": null }, { "$is-array": { "$const": [1] } },
            { "$is-object": { "$const": {} } },
            { "$string": 12 }, { "$number": "12" }, { "$boolean": 1 },
            { "$coalesce": ["$.missing", "fallback"] },
            { "$default": ["$.missing", 0] } ] }
```

### 8.11 Schema operators — `$valid $assert`

**JSON Schema is this language's type system.** Where XQuery bolted XML
Schema onto its type lattice, this format embeds JSON Schema documents
directly inside query documents, as type tests and assertions. The same
vocabulary that validates the data validates it *inside* queries.

**Schema literals.** The second argument of `$valid`/`$assert` — like each
member value of the `$as` clause (§6.8) — is a **JSON Schema literal**: a
JSON value taken **verbatim**. It is never normalized or evaluated as a
query expression; JSON Schema's `$`-prefixed keywords (`$ref`, `$defs`, ...)
do not collide with Rule 1, `"$name"` strings inside it stay literal strings,
and its arrays are not array constructors. Consumers MUST deep-copy and
freeze the literal (like `$const`) and MUST compile it exactly once, at
query compile time. The format's own JSON Schema (§12) admits any JSON value
in schema-literal position and does **not** meta-validate it; validity of
the embedded schema is the type-test compiler's judgment (`JQ0009`).

**Per-item validation.** Both operators (and `$as`) validate the **items**
of a sequence, one at a time — the schema sees each item, never the sequence
itself. A sequence of three numbers validates against
`{"type": "number"}`, not against an array schema.

| Operator | Signature | Definition |
|---|---|---|
| `$valid` | `[expr, schema]` (exactly 2) | `true` iff **every** item of *expr*'s result satisfies *schema*; `true` over the empty sequence (vacuously, like `$every`). Never an error — the cheap test. |
| `$assert` | `[expr, schema]` (exactly 2) | Identity on success: returns *expr*'s result unchanged when every item satisfies *schema*. The first failing item is runtime error `JQ2008` (at the operator's `docPath`). |

```json
{ "$for": { "b": "$.store.book[*]" },
  "$where": { "$valid": ["$b", { "type": "object", "required": ["isbn"] }] },
  "$return": { "$assert": ["$b.price", { "type": "number", "minimum": 0 }] } }
```

**The type-test compiler hook (non-normative implementation note).** The
reference engine (`@jarenjs/json`) has **no dependency** on any JSON Schema
validator. It defines an extension point instead:

```
compileJsonQuery(doc, { compileTypeTest: (schemaJson, docPath) => (value => boolean) })
```

The hook is invoked once per schema literal at **query compile time**, with
the frozen literal and its RFC 6901 pointer; it returns the hot-path item
predicate the compiled query closes over. `@jarenjs/validate/query` exports
`createTypeTestCompiler(validatorOrFactory?)`, which compiles literals with
a `JarenValidator` (boolean mode, errors off) — supplying an instance with
registered schemas lets `$ref`s in query schema literals resolve against
them. The dependency direction is validate → json; any conforming validator
can implement the hook. A query using `$valid`/`$assert`/`$as` compiled
**without** a hook is compile error `JQ0008`; a hook that rejects a schema
literal (throws) is compile error `JQ0009` at the operator's `docPath`.

The same package closes the loop in the other direction: its `$query`
schema keyword embeds a query document inside a JSON Schema and asserts the
query's EBV (§2.2) against each validated instance — schemas inside queries
here, queries inside schemas there. Compiled queries expose `query.ebv`
beside `first`/`exists` for exactly this. See the `@jarenjs/validate`
README's "`$query` — cross-field assertions" section.

---

### 8.12 Registered functions, operators, collations, and execution limits

Three compile options make a compilation's **trusted host capabilities**
explicit — none of them changes the closed format: a document using them
compiles only against a host that registered them, and a host that
registered nothing keeps exactly the spec vocabulary.

**`options.functions` and `$call`.** A registry of named pure functions;
the `$call` phrase invokes one:

```json
{ "$call": ["upper", "$b.title"] }
```

The first item MUST be a literal string naming a registered function
(`JQ0010` otherwise). Argument expressions evaluate first; each crosses
the boundary as plain JSON — a sequence as an array of items, the empty
sequence as `undefined`. The function's return value is one item;
`undefined` is the empty sequence. A throwing function is runtime error
`JQ2010`. Functions MUST be pure over JSON: they are part of the query's
semantics, not an effect hatch.

**`options.extensions` and host `$`-operators.** A registry of named
operator entries that extend the closed operator vocabulary (§8) with
host-provided `$`-operators. Each entry has the same shape the built-in
operators use — `{ params, result, resultType, compile, normalize? }` —
so a registered `{ "$sqrt": "$b.x" }` normalizes, type-annotates (its
declared `resultType` flows through `annotateTypes`, Appendix C.8) and
compiles exactly like a built-in, and appears in
`query.dependencies.operators`. A name that collides with the closed
vocabulary is a `TypeError` at compile — a host programming error, never
a `JQ` document error. The intended way to build this registry is
`createJsltRegistry()` from `@jarenjs/json/jslt` (JSLT-FORMAT §13), which
composes plain-data packs of pure `@jarenjs/core` functions (math,
finance, statistics) into `{ extensions, functions }` and works across
stylesheets, bare queries and `@jarenjs/linq` — and, through
`@jarenjs/db`, in the query residual and (for the `pushable:'scalar'`
subset) as SQLite deterministic UDFs (MODEL-FORMAT §8.1–8.2). A document
compiled *without* a registry keeps exactly the spec vocabulary — `$sqrt`
is then `JQ0002`.

**`options.collations`.** A registry of named pure compare functions for
`$orderby`'s `$collation` member (§6.6).

**`options.limits`.** Deterministic limits enforced *inside* the
synchronous engine. Two of them are **output caps**: they bound what a
phrase or the query hands onward, NOT memory, fan-out or intermediate
accumulation.

- `sequenceItems` — bounds every FLWOR phrase materialization (the
  sequence a phrase *returns*) and tightens `$range`'s resource guard
  below its 2³² ceiling; exceeding it is `JQ2009` (`$range` keeps its
  historical `JQ2007`). A `$groupby`/`$orderby` barrier may accumulate
  arbitrarily many items — and a collation may run arbitrarily many
  comparisons — behind a small final output; bare paths, `$count` and
  other operators can likewise materialize above the cap internally.
- `resultItems` — bounds the final result at the query boundary
  (`JQ2009`), checked after evaluation; `first()`, `exists()` and
  `ebv()` deliberately bypass it.

The other two bound the **query** rather than its output:

- `steps` — bounds **expression-node evaluations** (`JQ2009`). A step is
  one node evaluation, not one primitive operation: a node that loops
  internally — materializing a `$range`, a general comparison's cross
  product, a sort's comparisons — counts once. It is the only limit that
  bounds work rather than output, and the only one that costs: setting
  it compiles a counter check into every node. The counter resets per
  evaluation, so a compiled query stays reusable.
- `depth` — bounds **expression nesting**, and is checked at **compile
  time** (`JQ0011`). The language has no recursion — no user-defined
  functions, no self-reference — so the compiled closure tree's maximum
  evaluation depth IS the document's static nesting. Checking it once is
  therefore exact, and costs nothing to evaluate.

An unknown limit name, or a value that is not a positive integer, is a
host programming error (`TypeError`), because an accepted-but-unenforced
limit would be a silent false guarantee.

Together these make trusted, developer-authored rules diagnosable, and
give user- or model-authored queries a deterministic work bound. They
still are not a sandbox: `steps` bounds evaluations, not memory, and a
wall-clock or CPU limit is out of scope by design — a synchronous run on
the caller's thread cannot be preempted, so a host needing hard
termination owns a worker or isolate.

**Dependencies and explanation.** The compiled query reports what it
needs: `query.dependencies` is a frozen `{ externals, operators,
functions, collations }`, and `query.explain()` returns that plus the
enforced limits as fresh plain JSON — the vetting surface for saved or
machine-authored rules.

### 8.13 Dates and times

JSON has no date type, so dates are **RFC 3339 strings** and these operators
are ordinary string operators with a calendar's worth of rules. Every one of
them is a **pure function of its operand**: there is deliberately no
`current-dateTime`, because a compiled query must give the same answer for
the same input document forever — it is cached by document identity, saved as
a rule, and usable as a validation keyword.

**Type predicates.** Unary `{"$is-date": e}`, `$is-time`, `$is-datetime`,
`$is-duration` — `true` iff `e` is a **singleton string** in that lexical
form (`full-date`, `full-time`, `date-time`, and the RFC 3339 Appendix A
duration grammar). Like the §8.10 `$is-*` family these never raise: the empty
sequence, a multi-item sequence and a non-string are all `false`. The forms
are disjoint — a `date-time` is not a `date`.

**Components.** Unary `$year`, `$month`, `$day`, `$hours`, `$minutes`,
`$seconds`, `$offset`. Each propagates the empty sequence and returns a
number. Components are read **lexically, in the value's own offset** — the
`fn:year-from-dateTime` reading, and the one that makes "group by month"
mean what an author expects. `$seconds` carries the fraction (`5.5`).
`$offset` is minutes east of UTC, and is the one component that yields the
**empty sequence** rather than an error when absent, because RFC 3339 leaves
a bare `full-date` offset-less.

Asking a value for a component of a half it does not have — the `$hours` of a
`full-date`, the `$year` of a `full-time` — is runtime error `JQ2001`, as is
an operand that is not an RFC 3339 value at all.

**Instants.** Unary `$epoch` maps a value carrying a date to **milliseconds
since 1970-01-01T00:00:00Z**, and `$datetime` maps such a number back to a
canonical UTC `date-time` string. `$epoch` is the one place a value is
shifted to UTC, which makes it the way to compare or subtract across
offsets — as *strings*, `"…T14:00:00+02:00"` sorts after `"…T12:00:00Z"`
though they are the same instant. A `full-time` has no instant to place
(`JQ2001`); so does a number outside the range RFC 3339 can spell.

**Calendar arithmetic.** `$date-add` and `$date-sub` shift a value, either
by an ISO 8601 duration (`[date, "P1M"]`) or by an amount and a unit
(`[date, 3, "day"]`). `$start-of` and `$end-of` truncate to a unit, and
`$date-diff` counts whole units from one value to another. The unit is
**data**, not vocabulary — one of `year`, `quarter`, `month`, `week`, `day`,
`hour`, `minute`, `second`, `millisecond` — so an unknown one is `JQ2001`
rather than a compile error.

Two rules make these predictable:

- **The lexical form is preserved.** A `full-date` shifted by a day is still
  a `full-date`, and a `date-time` keeps its own offset rather than being
  normalized to UTC. A query that buckets dates must not silently start
  producing date-times. Consequently `$end-of` on a `full-date` yields that
  unit's last *day*, where on a `date-time` it yields the last millisecond —
  a `full-date` has nowhere to put one.
- **Month arithmetic clamps.** `2026-01-31` plus one month is `2026-02-28`,
  because the alternative — overflowing into March — makes adding a month
  non-monotonic. `$date-diff` counts months to match, so adding its result
  back never overshoots: `2026-01-31` to `2026-02-28` is **one** month.

`$date-format` renders a value through a **Unicode LDML** pattern
(`yyyy-MM-dd`, not moment's `YYYY-MM-DD`); a literal pattern compiles once
with the query. Patterns are limited to the locale-independent tokens: month
and weekday *names* would need locale data this format does not carry, so
`MMMM`, `MMM`, `EEEE`, `EEE` and `a` are rejected — `JQ0003` for a literal
pattern, `JQ2001` for one computed at runtime. Localized rendering belongs to
the presentation layer, not to a query.

| Operator | Definition |
|---|---|
| `$is-date` `$is-time` `$is-datetime` `$is-duration` | singleton string in that RFC 3339 form → `true`; anything else → `false` |
| `$year` `$month` `$day` | lexical date components; a value with no date is `JQ2001` |
| `$hours` `$minutes` `$seconds` | lexical time components, `$seconds` including its fraction; a value with no time is `JQ2001` |
| `$offset` | minutes east of UTC; a bare `full-date` → empty |
| `$week` `$week-year` | ISO 8601 week number and its week-numbering year, which is not always the calendar year (2027-01-01 is week 53 of 2026) |
| `$quarter` `$weekday` | calendar quarter 1-4; ISO weekday 1 (Monday) to 7 (Sunday) |
| `$epoch` | date or date-time → milliseconds since the epoch (UTC); a `full-time` → `JQ2001` |
| `$datetime` | epoch milliseconds → canonical UTC `date-time`; out of RFC 3339 range → `JQ2001` |
| `$date-add` `$date-sub` | `[date, duration]` or `[date, amount, unit]` → a value of the same lexical form |
| `$start-of` `$end-of` | `[date, unit]` → the unit's first / last instant, in the same lexical form |
| `$date-diff` | `[from, to, unit]` → whole units, negative when `to` precedes `from` |
| `$date-format` | `[date, pattern]` → the value rendered through an LDML pattern |

Every operator that *produces* a date produces it in the same canonical
spelling, so one query can never emit two forms of one instant: a fractional
second appears only when non-zero and without trailing zeros
(`…:05.5Z`, never `…:05.500Z`).

Durations are recognized and applied, but never *decomposed* into a number:
`P1M` is not a fixed count of milliseconds, so there is no honest length to
report without a calendar anchor. Applying one to a date is where the anchor
exists, which is what `$date-add` is for; fixed-width spans go through
`$epoch` and ordinary `$sub`.

```json
{ "$for": { "e": "$.events[*]" },
  "$groupby": { "w": { "$start-of": ["$e.on", "week"] } },
  "$orderby": ["$w"],
  "$return": { "week": "$w", "count": { "$count": "$e" } } }
```

buckets events into ISO weeks — the shape components alone could not express,
because a week boundary is arithmetic, not a field.

```json
{ "$for": { "e": "$.events[*]" },
  "$where": { "$is-datetime": "$e.at" },
  "$groupby": { "y": { "$year": "$e.at" }, "m": { "$month": "$e.at" } },
  "$orderby": ["$y", "$m"],
  "$return": { "year": "$y", "month": "$m", "count": { "$count": "$e" } } }
```

### 8.14 Spatial

Geography enters the language the way dates did: through the format the data
already has. Operands are **GeoJSON** ([RFC 7946](https://datatracker.ietf.org/doc/html/rfc7946))
— a bare position `[longitude, latitude]`, a geometry, a `Feature`, or a
`FeatureCollection` — because that is what a JSON document holds. There is no
geometry type to construct, and a wrapper is unwrapped for you: passing a
`Feature` where a geometry is wanted is not an error, it is the common case.

Coordinates are longitude then latitude, in WGS 84 decimal degrees. RFC 7946
removed alternative coordinate reference systems, so there is nothing to
configure and no `crs` to honour.

**Measurements are geodesic, never planar.** A degree of longitude spans about
111 km at the equator and 68 km at 52°N, so a Euclidean answer over raw degrees
is wrong by two thirds over a kilometre at Dutch latitudes. `$distance`,
`$area` and `$length` answer in metres and square metres on the WGS 84 sphere,
accurate to under half a percent. Convert with ordinary arithmetic —
`{"$idiv": [{"$distance": [a, b]}, 1000]}` for kilometres.

`$distance` and `$within` measure a value by its **representative position**: a
bare position or `Point` is itself, anything else is its centroid. That is
stated rather than inferred because the alternative — the minimum distance
between two shapes — needs point-to-segment geodesics and is a much larger
piece of work this format does not yet do.

`$bbox-intersects` is named for exactly what it tests. An operator called
`$intersects` that compared only bounding boxes would be a lie the first time
two L-shaped regions shared a box and nothing else; real geometry-to-geometry
intersection is overlay work and is deliberately absent.

| Operator | Definition |
|---|---|
| `$bbox` | any value → `[west, south, east, north]`; a value with no positions → empty |
| `$area` | square metres of the value's polygons, exterior rings less holes; anything without a surface → `0` |
| `$length` | metres of the value's lines and ring perimeters; a point → `0` |
| `$centroid` | the mean of the value's positions, as a position. **Not** the area-weighted centre of mass: for a concave shape it can fall outside the polygon |
| `$distance` | `[a, b]` → metres between the two representative positions |
| `$within` | `[a, b]` → is `a`'s representative position inside `b`'s surface? Only a polygon has an inside, so a line or point as `b` is `false` |
| `$bbox-intersects` | `[a, b]` → do the two bounding boxes overlap? Touching edges count |
| `$geohash` | `[value]` or `[value, precision]` → the base-32 cell string; precision is 1-12, default 9 |

Note what needs **no** operator. A geohash is a string, so proximity is
`$starts-with` on a prefix and spatial bucketing is `$groupby` over
`$substring` — the existing vocabulary already indexes, groups and orders them.

```json
{ "$for": { "c": "$.cities[*]" },
  "$where": { "$within": ["$c.at", "$.region"] },
  "$orderby": [{ "$key": { "$distance": ["$c.at", "$.centre"] } }],
  "$return": { "name": "$c.name",
               "km": { "$idiv": [{ "$distance": ["$c.at", "$.centre"] }, 1000] } } }
```

selects the cities inside a region and orders them by how far they are from a
point — a spatial filter and a spatial sort, in the language's own clauses.

## 9. Variables, scoping, and external parameters

1. Variables are introduced by `$for`, `$let`, `$at`, `$count`, `$groupby`
   key names, and quantifier bindings. A variable is in scope in every
   *later* clause of its phrase (per the semantic order of §6.1), in later
   bindings of the same binding object (§6.2), and in all nested expressions
   there — but **not** inside embedded path filters (§3.2).
2. Inner bindings shadow outer bindings of the same name. Duplicate bindings
   within one phrase are `JQ0007` (§6.3).
3. **Externals.** A variable referenced but not bound by any enclosing phrase
   is an **external parameter**. The set of external names is collected at
   compile time and exposed by the compiled query; callers bind externals at
   call time. Evaluating a reference to an external that the caller did not
   bind is runtime error `JQ2006`. (There is no declaration syntax; use is
   the declaration. Consumers MAY offer static "all externals bound" checks.)

```json
{ "$query": "0.1",
  "$expr": { "$for": { "b": "$.store.book[*]" },
             "$where": { "$ge": ["$b.price", "$minPrice"] },
             "$return": "$b.title" } }
```

`$minPrice` is free — an external the caller binds at call time.

**Closed-world compilation.** Because use is the declaration, a typo in a
variable name is not an error: it quietly becomes a new external. A host that
knows the parameters it intends to expose MAY compile **closed-world**,
declaring them (`options.externals` in this implementation). Every free
variable that is not declared is then compile error `JQ0005` at its own
reference site, and an empty declaration list forbids externals entirely.
This changes no document semantics — a document that compiles closed-world
behaves identically compiled open — it only decides which documents compile.

> **Worked example (clause order and `$count`).** Scope follows the
> **semantic** clause order of §6.1, not document key order, and `$count`
> binds *after* `$where`. So a `$where` that mentions the phrase's own
> `$count` name does not see the tuple number — the name is not in scope
> yet, and rule 3 makes it an **external**:
>
> ```json
> { "$for": { "b": "$[*]" },
>   "$where": { "$lt": ["$n", 2] },
>   "$count": "n",
>   "$return": ["$b", "$n"] }
> ```
>
> `$n` in `$where` is external (the compiled query reports `["n"]`); `$n` in
> `$return` is the tuple number. This is correct and surprising, which is why
> it is worth stating: filtering by position is done with `$at` (§6.2), whose
> variable is in scope from the binding onward, not with `$count`.

---

## 10. Errors

### 10.1 Error objects

Consumers MUST raise compile-time errors as `JsonQueryCompileError` and
runtime errors as `JsonQueryRuntimeError`. Every error carries:

- `code` — a stable identifier from the registry below;
- `docPath` — an **RFC 6901 JSON Pointer into the query document** locating
  the offending construct (e.g. `/$expr/$where/$eq/1`);
- `message` — human-readable, non-normative.

### 10.2 Compile errors (`JQ0xxx`)

| Code | Condition | XQuery analogue (non-normative) |
|---|---|---|
| `JQ0001` | Object mixes `$`-prefixed and plain keys (§3.1) | XPST0003 |
| `JQ0002` | Unknown operator / `$`-key outside the vocabulary | XPST0017 |
| `JQ0003` | Known phrase with bad arity, value shape, or key combination | XPST0003 |
| `JQ0004` | String starting `$` is not a valid path or escape (§3.2) | XPST0003 |
| `JQ0005` | Variable reference that is neither bound nor a declared external under a closed-world compilation (§9); also an `$as` member naming a variable not bound by its phrase's `$for`/`$let` (§6.8) | XPST0008 |
| `JQ0006` | Version envelope with unknown or non-string `$query` (§4.2) | XQST0031 |
| `JQ0007` | Duplicate variable binding within one phrase (§6.3) | XQST0089 |
| `JQ0008` | Schema operator (`$valid`/`$assert`/`$as`) in a query compiled without a type-test compiler (§8.11) | XQST0009 |
| `JQ0009` | Schema literal rejected by the type-test compiler (invalid embedded schema, §8.11) | XQST0059 |
| `JQ0010` | `$call`/`$collation` naming no registered function/collation (§8.12, §6.6) | XPST0017 |
| `JQ0011` | Expression nesting deeper than `limits.depth` (§8.12) | XPDY0130 |

### 10.3 Runtime errors (`JQ2xxx`)

| Code | Condition | XQuery analogue (non-normative) |
|---|---|---|
| `JQ2001` | Runtime type error (non-number arithmetic operand, bad cast, ...) | XPTY0004 |
| `JQ2002` | `$idiv`/`$mod` by zero (§8.5) | FOAR0001 |
| `JQ2003` | EBV of a multi-item sequence (§2.2) | FORG0006 |
| `JQ2004` | `$map` key expression not a single string (§3.5.2) | XPTY0004 |
| `JQ2005` | Incomparable `$orderby`/`$sort` keys (§6.6, §8.9) | XPTY0004 |
| `JQ2006` | Reference to an unbound external parameter (§9) | XPDY0002 |
| `JQ2007` | Resource guard: an operator result exceeding an implementation limit (`$range` over 2³² items, §8.9) | XPDY0130 |
| `JQ2008` | Schema assertion failure: an item rejected by `$assert`'s schema, or a bound variable rejected by its `$as` schema (§6.8, §8.11) | XPTY0004 |
| `JQ2009` | An execution limit exceeded: `limits.sequenceItems` on a phrase materialization, `limits.resultItems` at the query boundary, or `limits.steps` expression evaluations (§8.12) | XPDY0130 |
| `JQ2010` | A registered `$call` function threw (§8.12) | FOER0000 |
| `JQ2011` | The input document is `undefined`, which is not a JSON value (§2.1) | XPDY0002 |

---

## 11. Deviations from XQuery 3.1

Normative registry. Everything not listed here follows XQuery 3.1.

| # | Deviation | Rationale |
|---|---|---|
| **D1** | All numbers are IEEE 754 doubles; no integer/decimal/float tower. `$div` by 0 is IEEE (`±Infinity`/`NaN`); `$idiv`/`$mod` by 0 error. | JSON has one number type; JavaScript engines have one. A numeric tower would be a fiction the data model cannot honor. |
| **D2** | `$eq`/`$ne` item equality is deep structural JSON equality (arrays/objects compare by structure), numbers mathematically. Existential lifting over sequences is retained. | XQuery's `eq` on maps/arrays is an error; for JSON, structural equality is the useful, obvious relation (and `$groupby`/`$distinct` need it anyway). |
| **D3** | EBV of a singleton array or object is `true`. | XQuery raises FORG0006 for function items; for JSON data, "the object is there" is the intuitive truthiness. Keeps EBV total over singletons. |
| **D4** | `$for` unpacks an item that is an array into its members (one level). Objects are not unpacked. | RFC 9535 paths return arrays as values; without unpacking, `$for` over `"$b.tags"` would iterate one array item. Escape: `$let` / `$const`. |
| **D5** | Regex operators use I-Regexp (RFC 9485), not XSD regular expressions. No flags argument. | Matches RFC 9535's regex dialect (one regex language across path filters and operators) and is interoperable by design. |
| **D6** | Positional values are 0-based: `$at`, `$count` (clause), `$substring`/`$subsequence` starts, `$index-of` results, `$get` indexes. | JSON and RFC 9535 array indexes are 0-based; a 1-based island inside them invites off-by-one errors. |
| **D7** | FLWOR clause keys apply in the fixed semantic order of §6.1 regardless of document key order; clause interleavings are expressed by nesting. One `$where`/`$groupby`/`$orderby`/`$count` per phrase. | JSON key order is not interoperable across ecosystems; semantics must not depend on it. Nesting expresses every interleaving. See also the correlation interop caveat, §6.2. |

---

## 12. The JSON Schema for query documents

### 12.1 Artifacts and draft policy

The complete structural grammar of this format is published as JSON Schema,
in two artifacts:

- `packages/json/schemas/jaren-query.schema.json` — **canonical**, draft
  2020-12, `$id` `https://jarenjs.dev/schemas/jaren-query/0.1`.
- `packages/json/schemas/jaren-query.draft-07.schema.json` — the draft-07
  twin, `$id` `https://jarenjs.dev/schemas/jaren-query/0.1/draft-07`.

Nothing in this format requires post-draft-07 keywords, so the canonical
schema is authored in a **draft-neutral keyword subset** and the twin is a
**mechanical derivation**: swap `$schema`, rename `$defs` →
`definitions`, rewrite `#/$defs/` ref targets, suffix the `$id` with
`/draft-07`. The subset rules (normative for schema maintenance):

- no keywords beside `$ref` in any schema object that has `$ref` (draft-07
  ignores `$ref` siblings; wrap in `allOf` where composition is needed);
- no `unevaluatedProperties` / `unevaluatedItems`;
- no `$dynamicRef` / `$dynamicAnchor`;
- no tuple validation (2020-12 `prefixItems` and draft-07 array-form `items`
  are mutually incompatible) — operator argument arrays validate with uniform
  `items` plus `minItems`/`maxItems`. Nothing is lost: every argument
  position is an expression anyway, and per-position facts ("this key must
  evaluate to a string") are runtime rules owned by the compiler (`JQ2xxx`),
  not structure;
- allowed keywords: `type`, `oneOf`/`anyOf`/`allOf`, `properties`,
  `required`, `additionalProperties`, `patternProperties`, `propertyNames`,
  `pattern`, `enum`/`const`, boolean schemas, `minProperties`/
  `maxProperties`, `minItems`/`maxItems`, uniform `items`, `format`,
  recursive `$ref` — all draft-06+ with identical semantics in both drafts.

### 12.2 What the schema does and does not enforce

The schema is **structural** validation; the compiler remains authoritative.
The schema enforces: the object partition rule (a map constructor admits no
`$`-prefixed key, an operator phrase admits only its own keys — a mixed
object matches neither and fails), the closed operator vocabulary and all
arities, binding-object shapes and variable-name lexemes, the envelope, and
the string forms of §3.2 (query-string head patterns; absolute paths
additionally carry `format: "json-path"` — the RFC 9535 format implemented by
`@jarenjs/formats`; note `format` is annotation-only by default from draft
2020-12 unless the validator enables assertion).

The schema cannot express, and therefore leaves to the compiler (stated in
`description`s in the artifacts): fixed clause ordering (semantic, not
structural — every key order is valid JSON), variable scoping and duplicate
detection (`JQ0005`/`JQ0007`), `$as` name binding (`JQ0005`), full grammar
of variable-rooted path segments (only the head is pattern-checked), the
co-occurrence rules of the extended `$for` binding (`$size`/`$step` require
`$window`, `$window` requires `$size`, §6.10), and all runtime typing rules. Schema-literal positions (§8.11) validate as `true` —
draft-neutral by definition; embedded JSON Schemas are deliberately **not**
meta-validated by these artifacts (the type-test compiler is authoritative,
`JQ0009`). Where the schema and this text disagree, this text wins and the
schema has a bug.

---

## Appendix A. Worked examples (normative fixtures)

Each example is committed verbatim as a fixture under
`test/json/fixtures/query-format/valid/` and MUST validate against both
schema artifacts. Examples run against the RFC 9535 bookstore document
(plus a `ratings` array where shown).

### A.1 Degenerate query — a bare JSONPath string

```json
"$.store.book[?@.price < 10].title"
```

The complete query document. Result: the titles of the cheap books, in
document order.

### A.2 Bookstore FLWOR

```json
{ "$for": { "b": "$.store.book[*]" },
  "$where": { "$lt": ["$b.price", 10] },
  "$orderby": "$b.price",
  "$return": { "title": "$b.title", "price": "$b.price" } }
```

One object per cheap book, cheapest first.

### A.3 Join

```json
{ "$for":    { "b": "$.store.book[*]", "r": "$.ratings[*]" },
  "$where":  { "$eq": ["$b.isbn", "$r.isbn"] },
  "$orderby": "$b.price",
  "$return": { "title": "$b.title", "stars": "$r.stars" } }
```

Nested iteration over books × ratings; the `$where` equijoin keeps matching
pairs (books without `isbn` produce the empty sequence on the left — the
existential `$eq` is false, so they drop out; contrast §5.2).

### A.4 Group + aggregate

```json
{ "$for": { "b": "$.store.book[*]" },
  "$groupby": { "genre": "$b.category" },
  "$return": { "genre": "$genre",
               "count": { "$count": "$b" },
               "avg": { "$avg": "$b.price" } } }
```

Books per genre: after grouping, `$b` is the group's book sequence (§6.5).

### A.5 `$let` + reshaping with computed keys

```json
{ "$let": { "prefix": "col_", "book": "$.store.book[0]" },
  "$return": { "$map": [
    [{ "$concat": ["$prefix", "title"] }, "$book.title"],
    [{ "$concat": ["$prefix", "price"] }, "$book.price"]
  ] } }
```

### A.6 `$const` and `$$` escapes in one document

```json
{ "template": { "$const": { "$for": "kept verbatim", "price": null } },
  "label": "$$price" }
```

A map constructor whose `template` member is quoted data (the inner `$for`
is never interpreted) and whose `label` member is the literal string
`"$price"`.

### A.7 Quantifier over a variable-rooted path

```json
{ "$let": { "books": "$.store.book[*]" },
  "$return": { "$some": { "b": "$books" },
               "$satisfies": { "$gt": ["$b.price", 20] } } }
```

### A.8 External parameter

```json
{ "$query": "0.1",
  "$expr": { "$for": { "b": "$.store.book[*]" },
             "$where": { "$ge": ["$b.price", "$minPrice"] },
             "$return": "$b.title" } }
```

`$minPrice` is an external (§9), bound by the caller; also demonstrates the
version envelope.

### A.9 Schema type tests — `$as` and `$valid`

```json
{ "$for": { "b": "$.store.book[?@.isbn]", "r": "$.ratings[*]" },
  "$as": { "b": { "type": "object", "required": ["isbn", "price"] } },
  "$where": { "$and": [
    { "$eq": ["$b.isbn", "$r.isbn"] },
    { "$valid": ["$r.stars", { "type": "number", "minimum": 0, "maximum": 5 }] }
  ] },
  "$orderby": "$b.price",
  "$return": { "title": "$b.title", "stars": "$r.stars" } }
```

The join of A.3 with JSON Schema as the type system (§6.8, §8.11): the path
filter pre-selects books that have an `isbn`, the `$as` clause *asserts*
that every joined `b` is an object carrying `isbn` and `price` (a violation
would be `JQ2008`, not a dropped tuple), and the `$valid` conjunct *filters*
rating pairs to plausible star values. Note the schema literals are verbatim
JSON Schema — their keywords are not query operators.

---

## Appendix B. LLM structured output (non-normative)

The entire language is one JSON Schema. That is not an implementation detail;
it is a headline feature.

Constrained decoding — the "structured output" mode of every major LLM
serving stack — takes a JSON Schema and makes it impossible for the model to
emit a token that leads outside the schema. Point that machinery at
`jaren-query.schema.json` and a model **cannot produce a structurally invalid
query**: no unknown operators, no three-argument `$eq`, no mixed
`$`/plain-key objects, no malformed version envelope. The closed vocabulary,
exact arities, and anchored patterns in the schema were designed with this
consumer in mind — every constraint the schema can express is one hallucination
class removed at generation time, before any code runs.

The residue is small and cheap to check: path-string grammar beyond the
anchored head patterns (fully validated where the `json-path` format is
asserted, since absolute path leaves carry `format: "json-path"`), variable
scoping, and the runtime typing rules — exactly the `JQ0xxx`/`JQ2xxx` errors
of §10, which arrive with a `docPath` pointer that can be fed straight back
to the model for repair. Compare the usual alternative — asking a model to
emit a bespoke query DSL as free text and parsing it hopefully — and the
trade is: grammar errors eliminated by construction, semantic errors reduced
to a machine-checkable, machine-repairable residue.

Provider structured-output modes support different JSON Schema subsets
regardless of the draft they advertise, and the strict ones enforce neither
`patternProperties`/`propertyNames` nor asserted `format`s and reject
`oneOf`. For those, a third artifact ships beside the two of §12.1:
`packages/json/schemas/jaren-query.llm-profile.schema.json`, `$id`
`https://jarenjs.dev/schemas/jaren-query/0.1/llm-profile` — a mechanically
derived, pure *relaxation* in which those constraints are removed (each
restated in the nearest `description`, which the model still reads) and
every `oneOf` becomes `anyOf`. Every canonical-valid query document
validates under the profile; the reverse is deliberately not guaranteed.
Hand the profile to the decoder, keep validating locally against the
canonical schema — the package [README](../README.md#generating-queries-with-llms)
walks the full pipeline.

Because query documents are plain JSON, they also travel well through the
rest of an LLM toolchain: function-call arguments, retrieval filters, and
audit logs all speak JSON already, and a generated query can be validated,
diffed, stored, and replayed without ever touching a parser.

The same constrained-decoding model applies to complete recursive
stylesheets; see
[JSLT-FORMAT Appendix B](./JSLT-FORMAT.md#appendix-b-llm-structured-output-non-normative)
and its mechanically query-derived schema twins.

## Appendix C. The normalized form (normative)

The engine compiles in two stages: stage 1 **normalizes** a query
document into a frozen abstract syntax tree (the grammar of §§3–9
resolved — object partitioning, phrase classification, string forms,
scope resolution, cardinality analysis); stage 2 specializes that tree
into closures. Stage 2 is an optimisation artifact and changes freely.
**Stage 1 is the language resolved, and this appendix publishes it as a
contract**: `analyzeQuery` (the package's `./query` subpath) returns the
normalized tree so a consumer — a translator, a planner, an analyzer —
can walk *the engine's own reading* of a document instead of inventing a
second one.

### C.1 The analysis entry point

```js
analyzeQuery(doc, options) -> {
  astVersion,   // integer; see the compatibility policy (C.7)
  root,         // the frozen node tree (C.3)
  externals,    // [{ name, slot }] in order of first appearance (§9)
  frameSize,    // total frame slots the tree addresses (C.5)
  dependencies, // { externals, operators, functions, collations }
  limits,       // the normalized limits record, or null
}
```

`analyzeQuery` accepts the same options as `compileJsonQuery` and
applies the same JQ0xxx rejections, with one deliberate difference:
**schema literals do not require `options.compileTypeTest`**. Where
compilation without the hook is `JQ0008`, analysis normalizes the schema
literal to its `raw` node carrying the frozen schema with **no compiled
predicate** (`test` is `null`), so a consumer can analyse a document it
could not execute. When the hook IS supplied, analysis compiles the
predicate exactly as compilation would (and can therefore still raise
`JQ0009`). Everything else — `$call`/`$collation` registry resolution,
closed-world externals, limits validation — behaves identically in both
modes.

A caller wanting both pays for one normalization:
`compileJsonQuery(doc, { analysis: true })` exposes the same record at
`query.analysis` on the compiled query.

`NODE_KINDS` (same subpath) is the frozen, sorted list of the twelve
node kinds of C.3; `AST_VERSION` is the current version integer.

### C.2 The cardinality lattice

Every node carries `card`, a static **upper approximation** of its
runtime sequence length:

| value | constant | meaning |
|---|---|---|
| 0 | `CARD_ZERO` | statically the empty sequence |
| 1 | `CARD_ONE` | always exactly one item |
| 2 | `CARD_OPT` | zero or one item |
| 3 | `CARD_MANY` | any number of items (the top) |

Two combinators are part of the contract: `joinCard(a, b)` is the least
upper bound (the cardinality of "one branch or the other", `$if`), and
`sumCard(a, b)` is concatenation (`$seq`): `ZERO` is its identity and
any two non-`ZERO` contributions give `MANY`. Path nodes additionally
carry `singular` (C.3), the RFC 9535 singular-query judgement of their
segment list.

### C.3 The twelve node kinds

Every node is a plain frozen object carrying at least
`{ kind, card, docPath }`. The complete field sets:

| kind | fields beyond `kind`/`card`/`docPath` |
|---|---|
| `literal` | `value` — a frozen JSON value (scalars, `$const` payloads, non-`$` strings) |
| `var` | `slot`, `external` (boolean), `name` (`'$'` for the input document, slot 0) |
| `path` | `name` (root variable), `rootSlot`, `external`, `rootCard`, `segments` (the frozen RFC 9535 segment list of `parseJSONPath`), `singular` |
| `object` | `entries` — `[{ name, expr }]`, the map constructor of Rule 1 |
| `map` | `pairs` — `[{ key, value }]`, the general `$map` constructor |
| `array` | `elements` — `[node]`, the Rule 3 array constructor |
| `raw` | `value` — a frozen verbatim JSON value (operator `raw`/`name`/`schema` argument positions); schema positions also carry `test` — the compiled predicate, or `null` under analysis without a hook |
| `op` | `name`, `args` — `[node]`; `$range` under `limits` also carries `limits`; host extension operators also carry `entry` (the host's registry entry, an opaque host value) |
| `call` | `name`, `fn` (the registered host function — an opaque host value), `args` |
| `let` | `bindings` — `[{ name, slot, expr }]`, `ret` (the degenerate `{$let, $return}` phrase) |
| `quant` | `some` (boolean), `bindings` — `[{ name, slot, expr }]`, `satisfies` |
| `flwor` | see C.4 |

**Host-valued members.** `raw.test`, `call.fn`, `op.entry` and an
orderby spec's `collation` are the four places the tree carries host
functions rather than JSON. A consumer that serializes or diffs the tree
MUST treat them as opaque presence/absence facts; everything else in the
tree is plain JSON.

### C.4 The `flwor` node

The full phrase (§6) normalizes to one node with the clauses in their
fixed semantic order regardless of JSON key order:

- `fold` — `null` or `{ name, slot, expr, docPath }` (§6.9); the initial
  value is normalized in the ENCLOSING scope.
- `forBindings` — `[{ name, slot, expr, atSlot, allowingEmpty, window }]`;
  `atSlot` is `-1` without `$at`; `window` is `null` or
  `{ sliding, size, step }` (§6.10).
- `letBindings` — `[{ name, slot, expr }]`.
- `asChecks` — `null` or `[{ name, slot, isLet, schema, test, docPath }]`
  (§6.8); `test` is `null` under analysis without a hook.
- `where` — `null` or a node.
- `groupby` — `null` or `{ keys: [{ name, slot, expr, docPath }],
  docPath, accSlots }`; `accSlots` is the frozen list of pre-group
  binding slots that later clauses actually read (barrier liveness — an
  over-approximation-free artifact of `collectReadSlots`).
- `orderby` — `null` or `{ specs: [{ key, desc, emptyGreatest,
  collation, collationName, docPath }], docPath, liveSlots }`;
  `liveSlots` is the analogous snapshot liveness list at the sort
  barrier.
- `count` — `null` or `{ name, slot }`.
- `ret` — the `$return` node.
- `limits` — the normalized limits record, or `null`.

### C.5 Slots, frames, and external resolution

A compiled query evaluates against one frame array. **Slot 0 is the
input document.** Every binding site — `$for` names, `$at` names, `$let`
names, `$fold`'s accumulator, `$groupby` key names, `$count` — and every
external parameter is allocated the next slot from a single counter, in
normalization order; nested phrases keep allocating in the same frame.
`frameSize` is the final counter (one more than the highest slot; under
`limits.steps` one extra slot holds the step counter). Scoping is
lexical: a name resolves to the innermost binding; a free name is an
**external parameter**, allocated a slot at its first appearance (use is
the declaration, §9) and reported in `externals` in that order. Under a
closed-world compilation (`options.externals`) a free name outside the
declared set is `JQ0005` at its own reference site. An external's `card`
is `CARD_ONE` (the caller binds one JSON value).

### C.6 `docPath` and the freezing guarantee

Every node's `docPath` is an RFC 6901 JSON Pointer into the query
document as written: `''` is the document root (or `/$expr`-prefixed
under the version envelope, §4), object member names are
pointer-escaped, operator argument positions append the operator key and
the array index (`/$where/$eq/0`). It is the same pointer surface the
`JQ0xxx` errors carry.

The tree is **deeply frozen at every level** — nodes, binding records,
segment lists, captured values. That is a guarantee, not an
implementation detail: a consumer may hold, share and index the tree
without defensive copies, and MUST NOT mutate it (annotation passes
return new trees; see `annotateTypes`). Captured document fragments
(`literal`/`raw` values, schemas) are deep-frozen COPIES — the caller's
objects are never frozen.

### C.7 The compatibility policy

`AST_VERSION` (currently **1**) is bumped when a node kind is added or
removed, a published field is removed or retyped, or an invariant of
this appendix changes.

- Adding a **new optional field** to a node is NOT a version bump;
  consumers must tolerate unknown fields.
- Adding a **node kind** IS a version bump: an exhaustive consumer
  dispatching on `kind` must fail loudly on a kind it does not know,
  and the version tells it why.
- Explicitly **not** promised: the compiled closures, the operator
  registry's internals (`compile` bodies), evaluation order beyond what
  §§2–9 already require, and the two liveness lists' exact contents
  beyond "the slots later clauses read".

### C.8 Type annotation (optional pass)

The tree carries cardinality but no value types. `annotateTypes`
(same subpath) is a separate, optional pass:

```js
annotateTypes(analysis, { typeOf }) -> analysis'
```

It returns a NEW analysis whose tree mirrors the input with a frozen
`type` tag on every node — `{ type: 'unknown' | 'null' | 'boolean' |
'number' | 'integer' | 'string' | 'array' | 'object', optional:
boolean }` — never mutating the input and never running during
compilation. `typeOf(pathNode)` is the caller's answer for path nodes
(a store schema, a model — whatever the caller knows); returning
`null`/`undefined` means unknown. Literals and constructors type
themselves; quantifiers are boolean; operators propagate through the
registry's declared `resultType` families (comparison, arithmetic,
string, aggregate — everything undeclared yields `unknown`).
**`unknown` is always a safe answer; a wrong tag is a defect.** General
inference beyond these rules is out of scope here.
