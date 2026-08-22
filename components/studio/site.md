---
package: "@jarenjs/studio"
card:
  title: Studio
  blurb: >-
    The project IDE: a multi-file project — an app document beside the schema,
    view, actions, model and query files it sits with — is one document, each
    file validated against its own published grammar, assembled into runnable
    artifacts and hosted live by the studio widget. The engine is headless; the
    component layer is the IDE.
---

The Studio ([#/project](#/project)) hosts a user- or AI-authored `@jarenjs/app`
document — initial state, a JSLT view stylesheet and named actions as one JSON
value — as a live application next to the site's own. The document is one `app`
file inside a multi-file project IDE, beside the query, JSLT, schema and data
files it can sit with. This is the honest version of "one prompt → website" for
this suite: the site does not scaffold a foreign repo, it lets the model author
the suite's own app format, gated by the suite's own meta-schema, rendered by the
suite's own view engine. The AI writes JSON; Jaren validates it; the app runtime
runs it. No eval, no server, CSP-safe.

Why this shape works: an app document IS a website — the jarenjs site itself is
one — so the generative tier needs no new runtime, only a safe host for a second,
untrusted document. The threat model is the meta-schema:
`jaren-app.schema.json` (composing the published query and JSLT grammars) is
compiled by `@jarenjs/validate` and gates every boot. The nested app is granted no
effects and no subs, so a document is inert JSON — the worst a hostile or
hallucinated document can do is fail validation or render junk inside its
error-contained mount. Boot is atomic: a document that fails mid-boot leaves no
half-mounted DOM.

Iteration is patch-based, not resend-based: a weak local model cannot re-emit a
200-line document per turn, but it can emit an RFC 6902 patch — and the suite's
own patch engine applies it, with the patched result re-validated before it swaps
in (an invalid result is rejected atomically; the current document stays live).
Dogfooding is the feature: the assistant's studio tools — `jaren_studio_write`,
`jaren_studio_patch`, `jaren_studio_read` and `jaren_get_templates` for the app
document, plus `jaren_project_files`, `jaren_project_write` and
`jaren_project_run` for the project as a file tree — are the same schema-guarded
toolbox as everything else. The project tools matter for honesty as much as
capability: an assistant that could only read the app document would answer
questions about "my project" from one file and confidently miss the rest.

```json
{ "$app": "0.1",
  "state": { "count": 0 },
  "view": { "$jslt": "0.1", "rules": [
    { "match": "$", "body": ["main", {},
      ["h2", {}, "Count: ", "$.count"],
      ["button", { "on": { "click": "inc" } }, "+"]] }
  ] },
  "actions": {
    "inc": { "patch": [{ "op": "replace", "path": "/count",
                         "value": { "$add": ["$.count", 1] } }] }
  } }
```

Documents may name four render capabilities as widgets — `form`
(`{ schema, data }`: the standard forms stylesheet with live JSON Schema errors),
`chart` (`{ config }`: an `@jarenjs/charts` definition), `markdown` and `mermaid`
(`{ source }`) — each a pure props-to-vnode projection through the shipped
compilers. Keep what you build: studio documents save into the experiment store,
share as links (with an honest size limit), and download as JSON. Granting
effects or subs to studio documents is a deliberate non-goal for now — that is a
later step with its own threat model.

**Try it.** [Open the Studio](#/project), load a seed template — a validated
form, a charts dashboard, a routed mini-site — and edit the JSON, or ask the
assistant to build on one via template + patch.
