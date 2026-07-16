# The Jaren JSON Query Format

**Version 0.1 — Specification**

Module: `@jarenjs/json/query` (engine implemented in later work orders; this
document is the language contract).

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

The same flattening applies to the member value expressions of a map
constructor and to every other expression position; it is a property of the
sequence data model, not of the array constructor alone. To embed an array
*as a value* without evaluation, use `$const` (§3.5.1); to bind one without
iteration, use `$let` (§6.3).

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
- *valueExpr* is evaluated as an ordinary expression (its result flows per
  §3.4).
- Later pairs win on duplicate keys.

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

A FLWOR phrase is an operator phrase containing `$for` and/or `$let`, plus
optional clauses, plus the REQUIRED `$return`:

| Key | Value | Presence |
|---|---|---|
| `$for` | binding object (§6.2) | at least one of `$for`, `$let` |
| `$let` | binding object (§6.3) | at least one of `$for`, `$let` |
| `$where` | expression | OPTIONAL |
| `$groupby` | binding object (§6.5) | OPTIONAL |
| `$orderby` | key spec or array of key specs (§6.6) | OPTIONAL |
| `$count` | variable name string (§6.7) | OPTIONAL |
| `$return` | expression | REQUIRED |

The clauses apply in **fixed semantic order regardless of their order in the
JSON document** (**D7**):

```
$for → $let → $where → $groupby → $orderby → $count → $return
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
the surviving tuple stream, in tuple order.

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
values with a `[*]` path segment (a future `$entries` operator is the planned
counterpart for member pairs).

**Multiple bindings** nest left-to-right in document key order, exactly like
consecutive XQuery `for` clauses, and **may be correlated**: a later source
may reference variables bound earlier in the same `$for` object.

> **Interop caveat.** Correlation is the one place where the *relative order*
> of keys inside a single binding object matters. Producers on
> key-order-hostile stacks SHOULD emit one binding per phrase, nesting
> phrases, instead of relying on multi-key binding objects.

**Extended binding form** — a source written as

```json
{ "$in": expr, "$at": "posName" }
```

iterates `expr` like a plain source and additionally binds *posName* to the
**0-based** (D6) position of the current item within the iterated sequence.
Both keys are REQUIRED in this form (a positionless binding is simply the
plain form); *posName* MUST be a valid variable name.

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
  key value (a singleton per group).
- Tuples with equal key combinations form one group. Key equality is **deep
  structural JSON equality** (`equalsJson`-grade, the same relation as `$eq`
  item equality, §8.4), with numbers compared mathematically.
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
{ "$key": expr, "$dir": "asc" | "desc", "$empty": "least" | "greatest" }
```

with `$key` REQUIRED and `$dir` (default `"asc"`) and `$empty` (default
`"least"`) OPTIONAL.

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
  `JQ2005`.
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

Operators marked **(TODO_06)** are normatively *named and shaped* by this
specification — their key, argument arity, and result kind are fixed here so
the schema and vocabulary are stable — but their full semantic definitions
land with the operator library work order. Their arities below are normative;
semantic notes are provisional summaries.

Reserved, undefined keys (rejected by v0.1 consumers and by the schema):
`$valid`, `$assert`, `$as`. They are reserved for the JSON-Schema-as-type-
system layer.

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
  `JQ2002`.
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

| Operator | Signature | Notes |
|---|---|---|
| `$concat` | `{"$concat": [e, ...]}` (≥ 0) | Variadic concatenation. Each operand is cast to string per `$string`; an empty-sequence operand contributes `''`. `{"$concat": []}` is `""`. |
| `$string-join` **(TODO_06)** | `[seq, sep?]` (1–2) | Join with separator, default `""`. |
| `$substring` **(TODO_06)** | `[str, start, len?]` (2–3) | *start* 0-based (D6). |
| `$contains` **(TODO_06)** | `[str, sub]` | Substring test. |
| `$starts-with` **(TODO_06)** | `[str, prefix]` | |
| `$ends-with` **(TODO_06)** | `[str, suffix]` | |
| `$upper` **(TODO_06)** | `{"$upper": e}` | Unicode default uppercase. |
| `$lower` **(TODO_06)** | `{"$lower": e}` | Unicode default lowercase. |
| `$string-length` **(TODO_06)** | `{"$string-length": e}` | Length in Unicode scalar values. |
| `$normalize-space` **(TODO_06)** | `{"$normalize-space": e}` | XQuery `fn:normalize-space`. |
| `$match` **(TODO_06)** | `[input, pattern]` | Full-string regex match. |
| `$search` **(TODO_06)** | `[input, pattern]` | Substring regex match (XQuery `fn:matches`). |
| `$replace` **(TODO_06)** | `[input, pattern, replacement]` (exactly 3) | Replace all matches. |

Regular expression operators use **I-Regexp (RFC 9485)** syntax — the same
interoperable regex dialect RFC 9535 uses — not XSD regular expressions
(**D5**). I-Regexp has no flags argument, hence `$replace`'s fixed arity 3.

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

### 8.8 Aggregates **(TODO_06)** — `$count $sum $avg $min $max`

Each is unary: `{"$count": e}` etc. Provisional semantics: `$count` returns
the number of items in `e`'s result; `$sum` of an empty sequence is `0`;
`$avg`, `$min`, `$max` of an empty sequence are the empty sequence; non-number
items in `$sum $avg $min $max` are runtime error `JQ2001`. See §6.7 for the
`$count` clause/operator collision note.

### 8.9 Sequence operators **(TODO_06)** — `$distinct $reverse $sort $head $tail $subsequence $index-of $range $get`

| Operator | Signature | Provisional semantics |
|---|---|---|
| `$distinct` | `{"$distinct": e}` | Distinct items by deep equality (D2), first occurrence order. |
| `$reverse` | `{"$reverse": e}` | Reverse the sequence. |
| `$sort` | `{"$sort": e}` | Sort ascending by item value; `$orderby` key-type rules apply (`JQ2005`). |
| `$head` | `{"$head": e}` | First item, or empty. |
| `$tail` | `{"$tail": e}` | All but the first item. |
| `$subsequence` | `[seq, start, len?]` (2–3) | *start* 0-based (D6). |
| `$index-of` | `[seq, item]` | 0-based (D6) positions of deep-equal items. |
| `$range` | `[start, end]` | Integers from *start* to *end* inclusive (XQuery `to`); empty when *start* > *end*. |
| `$get` | `[seq, index]` | Item at 0-based (D6) index, or empty. |

Combined example (also exercises the aggregates of §8.8):

```json
{ "$seq": [ { "$count": "$.store.book[*]" }, { "$sum": "$.store.book[*].price" },
            { "$avg": "$.store.book[*].price" }, { "$min": "$.store.book[*].price" },
            { "$max": "$.store.book[*].price" }, { "$distinct": "$.store.book[*].category" },
            { "$reverse": "$.store.book[*].title" }, { "$sort": "$.store.book[*].price" },
            { "$head": "$.store.book[*]" }, { "$tail": "$.store.book[*]" },
            { "$subsequence": ["$.store.book[*]", 1, 2] },
            { "$index-of": ["$.store.book[*].category", "fiction"] },
            { "$range": [1, 5] }, { "$get": ["$.store.book[*]", 0] } ] }
```

### 8.10 Types and casts **(TODO_06)**

Unary predicates `{"$is-string": e}`, `$is-number`, `$is-boolean`, `$is-null`,
`$is-array`, `$is-object` — `true` iff `e` is a singleton of that type
(empty and multi-item sequences yield `false`).

Unary casts `{"$string": e}`, `{"$number": e}`, `{"$boolean": e}` —
provisional: XQuery-style casts to the JSON analogue types (`$boolean` is the
EBV, `$number` parses strings and maps `true`/`false` to `1`/`0`, `$string`
of the empty sequence is `""`); a cast that cannot succeed is `JQ2001`.

| Operator | Signature | Provisional semantics |
|---|---|---|
| `$coalesce` | `{"$coalesce": [e, ...]}` (≥ 1) | Result of the first operand whose result is non-empty, else empty. Operands after it are not evaluated. |
| `$default` | `[e, fallback]` | `e`'s result if non-empty, else *fallback*'s. |

```json
{ "$seq": [ { "$is-string": "abc" }, { "$is-number": 1 }, { "$is-boolean": true },
            { "$is-null": null }, { "$is-array": { "$const": [1] } },
            { "$is-object": { "$const": {} } },
            { "$string": 12 }, { "$number": "12" }, { "$boolean": 1 },
            { "$coalesce": ["$.missing", "fallback"] },
            { "$default": ["$.missing", 0] } ] }
```

---

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
| `JQ0005` | Variable reference that is neither bound nor collectible as an external (reserved for closed-world compilation modes; see §9) | XPST0008 |
| `JQ0006` | Version envelope with unknown or non-string `$query` (§4.2) | XQST0031 |
| `JQ0007` | Duplicate variable binding within one phrase (§6.3) | XQST0089 |

### 10.3 Runtime errors (`JQ2xxx`)

| Code | Condition | XQuery analogue (non-normative) |
|---|---|---|
| `JQ2001` | Runtime type error (non-number arithmetic operand, bad cast, ...) | XPTY0004 |
| `JQ2002` | `$idiv`/`$mod` by zero (§8.5) | FOAR0001 |
| `JQ2003` | EBV of a multi-item sequence (§2.2) | FORG0006 |
| `JQ2004` | `$map` key expression not a single string (§3.5.2) | XPTY0004 |
| `JQ2005` | Incomparable `$orderby`/`$sort` keys (§6.6) | XPTY0004 |
| `JQ2006` | Reference to an unbound external parameter (§9) | XPDY0002 |

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
detection (`JQ0005`/`JQ0007`), full grammar of variable-rooted path segments
(only the head is pattern-checked), and all runtime typing rules. Where the
schema and this text disagree, this text wins and the schema has a bug.

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

Because query documents are plain JSON, they also travel well through the
rest of an LLM toolchain: function-call arguments, retrieval filters, and
audit logs all speak JSON already, and a generated query can be validated,
diffed, stored, and replayed without ever touching a parser.
