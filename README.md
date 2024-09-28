![Jaren](jaren.png)

# Jaren

Jaren is a high-performance JSON Schema Validating Compiler written in vanilla JavaScript. It offers full support for `draft6`, `draft7`, and partial support for `draft2019` and `draft2020`. Jaren is designed for speed and is under active development.

This library started as a personal merge of some useful javascript algorithms, functions, modules and classes, I programmed or snippits that I used over the years; stuff that I used and didn't want to forget about and wrapped them in an organized way into a monorepo as a JSON Schema validating compiler library that anyone can use.

Please read [Understanding JSON Schema](https://json-schema.org/UnderstandingJSONSchema.pdf) for a more comprehensive guide on what JSON Schema is (not Jaren!).

## 🚀 Quick Start

We recommend you clone this repository and install the dependencies with nodejs by just running the following command in the terminal at the root of the repository.

```bash
npm install
npm run build
npm run cover
```

At its current state, we recommend you use the `@jarenjs/validate` package, which is stable and will not change any of its public interfaces. 

For format support please use the `@jarenjs/formats` package with it.

But for now its recommended you dive into the test folder and try to find your way from there.

## 🔑 JSON Schema Validation Keywords

```
Programming is like sex.

One mistake and you have to support it for the rest of your life.
```

Jaren supports a wide range of JSON Schema validation keywords. Here's a quick overview:

- JSON data type: `type`, `nullable`, `required`
- Numbers: `maximum`, `minimum`, `multipleOf`
- Strings: `maxLength`, `minLength`, `pattern`
- Arrays: `maxItems`, `minItems`, `uniqueItems`, `items`, `contains`
- Objects: `maxProperties`, `minProperties`, `required`, `properties`, `patternProperties`
- All types: `enum`, `const`
- Compound: `not`, `oneOf`, `anyOf`, `allOf`, `if/then/else`
- Meta: `$id`, `$ref`, `$anchor`

<details>
<summary>🔥 For a complete list of supported keywords and their implementation status, click here</summary>

### 🔑 JSON data type

- type
- nullable | _(OpenAPI)_
- required | _as boolean (OpenAPI)_

### 🔑 Keywords for numbers

- maximum / minimum<br />or exclusiveMaximum / exclusiveMinimum
- multipleOf

### 🔑 Keywords for strings

- maxLength / minLength
- pattern

### 🔑 Keywords for format

- format
- formatMinimum / formatMaximum<br />or formatExclusiveMinimum / formatExclusiveMaximum

### 🔑 Keywords for array

- maxItems / minItems
- uniqueItems
- items
  - items | as schema or tuple _deprecated in `draft2020`_
  - items | as schema only _new `draft2020`_
- prefixItems | as tuple _new `draft2020`_
- additionalItems | as schema _deprecated in `draft2020`_
- contains
- maxContains / minContains | _new `draft2019`_
- ❌ unevaluatedItems | _new `draft2019` (in-progress)_

### 🔑 Keywords for object

- maxProperties / minProperties
- required | _as array!_
- properties
- patternProperties
- additionalProperties
- dependencies | _deprecated in `draft2019`_
- dependentRequired | _new `draft2019`_
- dependentSchemas | _new `draft2019`_
- propertyNames
- ❌ unevaluatedProperties | _new `draft2019` (in-progress)_
- ❌ [propertyDependencies](https://github.com/json-schema-org/json-schema-spec/blob/main/proposals/propertyDependencies.md)

### 🔑 Keywords for all types

- enum
- const

### 🔑 Compound keywords

- not
- oneOf
- anyOf
- allOf
- if / then / else

See also:
- [Schema Composition](https://json-schema.org/understanding-json-schema/reference/combining)
- [Applying Subschemas Conditionally](https://json-schema.org/understanding-json-schema/reference/conditionals)

### 🔑 Meta keywords

- ❌ $schema
- $id
- $ref
- $anchor
- ❌ $recursiveRef | _new `draft2019` &amp; deprecated in `draft2020`_
- ❌ $recursiveAnchor | _new `draft2019` &amp; deprecated in `draft2020`_
- ❌ $dynamicRef | _new `draft2020`_
- ❌ $dynamicAnchor | _new `draft2020`_
- ❌ $data | _(Ajv specific)_
- ❌ [$vocabulary](https://github.com/json-schema-org/json-schema-spec/blob/main/proposals/vocabularies.md) | _new `draft2020`_

### 🔑 Miscellaneous keywords

- ❌ strict
- strictFormat | used to enforce a specific format type like numbers and integers _(in-progress)_
- ❌ strictTuple
- ❌ errorMessage
- definitions | used by initial schema traversal _deprecated in `draft2019`_
- $defs | used by initial schema traversal _new `draft2019`_
- components | _(OpenAPI)_

</details>

## ✍ JSON Schema Validation Formats

Jaren supports various format validators for strings and numbers, including:

- Date and Time: `date-time`, `date`, `time`
- URLs and Emails: `url`, `email`, `hostname`, `ipv4`, `ipv6`
- Identifiers: `uuid`, `guid`, `identifier`
- Numbers: `int8`, `uint8`, `int16`, `uint16`, `int32`, `uint32`, `float32`, `float64`

But we have many more formats that are not listed here!

<details>
<summary>🔥 For a complete list of supported formats, click here</summary>

### ✍ Formats for strings

These format validators are based on the [json-schema.org](https://json-schema.org/understanding-json-schema/reference/string.html#built-in-formats) website.

#### 🗨 Formats for datetime

- `date-time` | according to [RFC3339](https://datatracker.ietf.org/doc/html/rfc3339#section-5.6), time-zone is mandatory
- `date` | according to [RFC3339](https://datatracker.ietf.org/doc/html/rfc3339#section-5.6), time-zone is mandatory
- `time` | according to [RFC3339](https://datatracker.ietf.org/doc/html/rfc3339#section-5.6), time-zone is mandatory

- ❌ `duration` | duration from RFC3339
- ❌ `iso-date-time` | date-time with optional time-zone
- ❌ `iso-time` | time with optional time-zone

*Note: All date time formats can use formatMinimum / formatMaximum and formatExclusiveMinimum and formatExclusiveMaximum*

#### 🗨 Formats for url's, hostnames and emails

- `url` | full URL
- `url--full` | same as `url`, but more comprehensive
- `uri` | full URI
- `uri--full` | same as `uri`, but more comprehensive
- `uri-reference` | URI reference, including full and relative URIs
- `uri-reference--full` | same as `uri-reference`, but more comprehensive
- `uri-template` | URI template according to [RFC6570](https://datatracker.ietf.org/doc/html/rfc6570)
- `iri` | full URI with international characters
- `iri-reference` | full URI reference with with international characters

- `email` | email address
- `email--full` | same as email, but more comprehensive
- `hostname` | host name according to [RFC1034](https://datatracker.ietf.org/doc/html/rfc1034#section-3.5)
- `idn-hostname` | host name with international characters
- `idn-email` | email address with international characters

#### 🗨 Formats for identifiers

- `uuid` | Universally Unique IDentifier according to [RFC4122](https://datatracker.ietf.org/doc/html/rfc4122)
- `guid` | Globally Unique IDentifier according to Microsoft

- `identifier` | C-type identifier
- `html-identifier` | html element `id` attribute identifier according to [RFC7992](https://datatracker.ietf.org/doc/html/rfc7992#section-5.1)
- `css-identifier` | css class name identifier according to [RFC7993](https://datatracker.ietf.org/doc/html/rfc7993)

- `mac` | ethernet interface identifier (EUI-48) according to [IEEE820](https://en.wikipedia.org/wiki/MAC_address)
- `ipv4` | IP v4 address according to [RFC791](https://datatracker.ietf.org/doc/html/rfc791)
- `ipv6` | IP v6 address according to [RFC2460](https://datatracker.ietf.org/doc/html/rfc2460)

#### 🗨 Formats for json pointers

- `json-pointer` | JSON-pointer according to [RFC6901](https://datatracker.ietf.org/doc/html/rfc6901)
- `json-pointer-uri-fragment` | JSON-pointer fragment according to [RFC6901](https://datatracker.ietf.org/doc/html/rfc6901#section-6)
- `relative-json-pointer` | relative JSON-pointer according to [draft-luff-relative-json-pointer-00](https://datatracker.ietf.org/doc/html/draft-luff-relative-json-pointer-00)
- ❌ `json-path` | JSONPath according to [RFC9535](https://www.rfc-editor.org/rfc/rfc9535.html)

#### 🗨 Miscellaneous formats

- `alpha` | allow only ASCII alpha characters (a-zA-Z)
- `numeric` | allow only numeric characters (0-9)
- `alphanumeric` | allow only ASCII alpha numeric characters
- `hexadecimal` | allow only hexadecimal characters (0-9a-fA-F)
- `uppercase` | allow only upper case alpha characters
- `lowercase` | allow only lower case alpha characters
- `color` | web color hex string (starts with #, must be 3 or 6 hax characters)
- `regex` | tests whether a string is a valid regular expression
- `base64` | base64 encoded data
- `byte` | same as `base64` format

- `isbn10` | International Standard Book Number 10 digit number
- `isbn13` | International Standard Book Number 13 digit number

- `country2` | Country code by alpha-2 according to ISO3166-1 _!No tests exists!_
- `iban` | International Bank Account Number _!No tests exists!_

### ✍ Formats for numbers

Formats for numbers validate both numbers and strings as number types. If you want to strictly only allow number types, you can explicitly set the `strictFormat` keyword to boolean `true` to only allow strict number or integer types.

#### 🗨 Formats integer numbers

- `int8` | signed 8 bit integer
- `uint8` | unsigned 8 bit integer
- `int16` | signed 16 bit integer
- `uint16` | unsigned 16 bit integer
- `int32` | signed 32 bit integer
- `uint32` | unsigned 32 integer
- `int64` | signed 64 integer
- `uint64` | unsigned 64 integer

#### 🗨 Formats floating point numbers

- `float16` | 16 bit floating point number
- `float32` | 32 bit floating point number
- `float64` | 64 bit floating point number
- `float` | 32 bit floating point number
- `double` | 64 bit floating point number

</details>

## 📅 Roadmap

```
I manager tried to open that door before,
but it apparently was scheduled for the next release.
```

- 0.8
  - current
- 0.9
  - [x] Jaren as a drop-in replacement for Ajv
  - [ ] add [benchmark](https://github.com/ebdrup/json-schema-benchmark) test suite for `draft7`
  - [ ] Fixing JSON error schema output
  - [ ] add error reporting tests
- 🎉 1.0 Stable release for `draft7`
  - add i18n
  - add development documentation
  - add examples
- 1.1
  - Modelling Inheritance with JSON Schema
  - Express array constraints more cleanly
- 1.2
  - Using Dynamic References to Support Generic Types
- 1.3
  - Runtime schema manipulation of constraints
- 1.4-1.9
  - Fix bugs and/or add forgotten features for latest draft compliance
- 2.0 🎉 Stable release for `draft2020`

<details>
<summary>🔥 To get the full picture and details about what that roadmap entails, click here</summary>

## 🛠️ Todo`s for latest draft validation

```
You can trust that if I say I do something, I will definitely do it unless I don't!
```

### 👉 Jaren as a drop-in replacement for Ajv

Jaren is a mono-repo with multiple workspaces in the ./packages directory. Because of this, Jaren imports its core, validator, formats and in later versions its reviver (see [JSON.parse]()) and replacer (see [JSON.stringify](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/JSON/stringify)) from its workspace packages. This has not been done yet and simply exports the available packages from its workspace imports, without wrapping them into a Jaren class that exposes a similar api as Ajv does.

On a extra note: Ajv compiles or a function or a promise. Jaren will NOT do this, instead it will expose an extra method for async compilers: compileAsync.
Note also: that Jaren will NOT include a default meta schema, but has to be added separately by the caller.

See also:
- [Getting Started](https://ajv.js.org/guide/getting-started.html)
- [Combining Schemas](https://ajv.js.org/guide/combining-schemas.html)

### 👉 Fixing JSON Schema output

From the blog post of the [json-schema.org](https://json-schema.org/blog/posts/fixing-json-schema-output) website. This feature needs to implement the following keywords in order for the proposed schema structure to work: `errorMessage`

See also:
 - [ajv-errors](https://github.com/ajv-validator/ajv-errors)

### 👉 Modelling Inheritance with JSON Schema

From the blog post of the [json-schema.org](https://json-schema.org/blog/posts/modelling-inheritance) website. This feature needs to implement the following keywords in order for the proposed schema structure to work: `unevaluatedProperties`. Jaren has already implemented some code to make this feature work by introducing the `ValidationResults` class and the refactoring of the compileObjectSchema functions.

See also:
- [json-schema-core](https://json-schema.org/draft/2020-12/json-schema-core#name-unevaluatedproperties)
- [Combining unevaluatedProperties and ref: # #375](https://github.com/orgs/json-schema-org/discussions/375)
- [additionalProperties](https://json-schema.org/understanding-json-schema/reference/object#additionalproperties)

### 👉 Express array constraints more cleanly

From the [release notes](https://json-schema.org/draft/2020-12/release-notes#contains-and-unevaluateditems) of the 2020-12 draft, there has been proposed a way to handle items that where neither validated by the items or contains keyword of an array schema object. This feature needs to implement the keyword `unevaluatedItems`.

### 👉 Using Dynamic References to Support Generic Types

From the blog post of the [json-schema.org](https://json-schema.org/blog/posts/dynamicref-and-generics) website. This feature needs to implement the following keywords in order for the proposed schema structure to work: `$dynamicAnchor`, `$dynamicRef`. We might also support `$recursiveAnchor` and `$recursiveRef` to be backwards compatible with `draft2019`

See also:
- [Understanding lexical dynamic scopes](https://json-schema.org/blog/posts/understanding-lexical-dynamic-scopes)
- [Improve/simplify "$recursiveAnchor" and "$recursiveRef"](https://github.com/json-schema-org/json-schema-spec/issues/909)
- [Lexical Scope and Dynamic Scope](https://json-schema.org/draft/2019-09/json-schema-core#rfc.section.7.1)
- [Keyword for extending a schema](https://github.com/json-schema-org/json-schema-spec/issues/907)
- [Recursive References with "$recursiveRef" and "$recursiveAnchor"](https://json-schema.org/draft/2019-09/json-schema-core#rfc.section.8.2.4.2)
- [$dynamicRef and $dynamicAnchor](https://json-schema.org/draft/2020-12/release-notes#dollardynamicref-and-dollardynamicanchor)

### 👉 Runtime schema manipulation of constraints

The Ajv JSON Schema validator has implemented the $data keyword that can extend the otherwise constant schema values with dynamic runtime values for the following keywords: `const`, `enum`, `format`, `minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minProperties`, `maxProperties`, `required`, `minItems`, `maxItems`, `uniqueItems`. This however has seen enough criticism from multiple developers claiming not to follow the json spec intention and or not being comprehensive enough for more radical manipulations. Besides those against the proposal, many developers and companies use the `$data` keyword, or other implementations like the `data-ref` proposal from json-everything, successfully.

See also:
- [$data](https://github.com/json-schema-org/json-schema-spec/issues/51)
- [Ajv $data spec](https://github.com/ajv-validator/ajv/tree/master/spec/extras/%24data)
- [data-ref](https://docs.json-everything.net/schema/examples/data-ref/)

</details>

## 📚Documentation

```
Procrastination

I will look up what that means, later...
```

For detailed documentation on using Jaren, including API references and advanced usage examples, visit our official documentation. Which is the code itself. 

### 🤓 Javascript Type Extensions

Even though es2017 is becoming pretty cool, `jaren` includes an extensive set of additional extensions to common types found in `@jarenjs/core`. We have added functionality for Number, String, Date, Object and Array classes including a set of test and getters related to the javascript type system.

For object types `@jarenjs/core` has special functions to manipulate array and objects alike including types like Map. `@jarenjs/core` also added some additional classes to queue or traverse tree like data structures.

### 🛂 String and Regex Extensions

We've added some additional string and regex functionality to the `@jarenjs/core/text` package to make it more powerful and flexible. You will find a lot of functionality to validate your input with. You can do this without using json schema and its formats. It can be really useful in day to day usage like checking for country codes, zip codes, iban numbers, etc. The `@jarenjs/formats` package exposes all the validation functions for the `@jarenjs/validate` package if you want to make use of them in a schema kind of way.

### 🧐Math and Vector classes

There are 4 extensive math classes defined in `@jarenjs/core/calc`; `int32`, `float64`, `vec2i32`, `vec2f64` and `vec3f64`. The Matrix class is not yet supported. `@jarenjs/core/calc` tries to encapsulate and group math functionality as much as possible. This with the idea to help the Javascript Runtime compiler determine what we are looking at. Each class has two types of operator groups; pure and impure. As the name suggests, pure operators are immutable and return a new structure, impure operators operates on the structure itself. The `@jarenjs/formats` package exposes some of these functions to make them available for the `@jarenjs/validate` package.

The `int32` and `float32` classes are mere helper functions to speed up your inner loops as some [benchmarks](https://jsperf.com/math-hypot-vs-math-sqrt/7) suggests. However, these benchmarks are highly [speculative](https://mrale.ph/blog/2014/02/23/the-black-cat-of-microbenchmarks.html) and the results differ greatly between browser versions. I still implemented them for two reasons; 1) sometimes I like to be explicit. 2) sometimes it helps me to remember how stuff works. The `int32` class also implements some complex operators like `sin`, `cos` and others too.

The vector classes `vec2i32`, `vec2f64` and `vec3f64` contain enough functionality to quickly do about any operation you want. The primitive pure operators (`add`, `sub`, `mul`, `div`) and impure operators (`iadd`, `isub`, `imul`, `idiv`) are supported for the `vec2i32`, `vec2f64` and `vec2f64` classes. They also contain product operators (`mag2` - magnitude square, `mag` - magnitude, `dot`, `crossABAB`) and other more complex vector operators (`unit`, `iunit`).

## 🤝 Contributing to Jaren

```
Is it true that when computer software is designed,
a back door is left for the designer to enter at will?
```

![Visual Studio Code](https://img.shields.io/badge/Visual%20Studio%20Code-0078d7.svg?style=for-the-badge&logo=visual-studio-code&logoColor=white)
![JavaScript](https://img.shields.io/badge/javascript-%23323330.svg?style=for-the-badge&logo=javascript&logoColor=%23F7DF1E)

We welcome contributions from the community! Here's how you can help:

1. Report Issues: Found a bug or have a feature request? Open an issue.
2. Improve Documentation: Help us make Jaren easier to use by improving our docs.
3. Add Tests: Increase our test coverage, especially for draft2019 and draft2020 features.
4. Implement New Features: Pick an item from our roadmap and submit a pull request.

## ❓ Frequently Asked Questions

```
  So frequently asked
  but never out spoken
  what shadow arises
  what hath thou awoken
```

<details><summary>

#### Why!?, Why would you create another json schema validator?
</summary>

I am aware of the excellent `Ajv` and `zod` validators, but I really needed to understand json schema in the first place and I wanted to do something else (see if I could beat its first place in speed). We as programmers work with validation all over the place, especially at the front-end, but also at the back-end and in the middle-ware. Since 2023 I started working a lot with LLM's and I believe that in order to work with them in a more natural way, we need to speak JSON, all the way down. So I decided to create a JSON Schema validator that is fully compliant with the JSON Schema specification and should be fast for the fun of it, but that is also easy to understand and easy to extend. Not by plugins perse, but by simply opening up the code and see what is going on.

</details>

<details><summary>

#### Why would you program it in vanilla javascript and not use typescript?
</summary>

Good question! I believe that vanilla javascript for a library like this is a little bit more straight forward to understand. And to be honest, I just like javascript. TypeScript is an excellent language but there is also a lot of boilerplate code that might be a bit too much for what we are trying to accomplish here. And I don't want to use a transpiler that might destroy my intentions of how it should be working, since I understand how the JIT compiler is working very well. Also I do use JSDoc to generate the documentation for the code and that should be enough for most of the users and TypeScript libraries when they want to make use of Jaren. Therefor I don't see the need for TypeScript here.

</details>

## 🙏 Be excellent to yourself, and each other!

If you find bugs, or want to know what a function is doing, please don't hesitate to ask me by filing an issue. Off topic questions I'd rather not see, but any jaren related question is very welcome.

Please file an issue at [the github jaren repository](https://github.com/jklarenbeek/jaren/issues).

