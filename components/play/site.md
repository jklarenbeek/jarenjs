---
package: "@jarenjs/play"
card:
  title: Play
  blurb: >-
    The engine playground: pick a JSON engine — JSON Schema, JSONPath, JSON
    Pointer, JSON Patch, query, JSLT, JTLT, JOSL, CSV, Markdown, Mermaid,
    Contract — feed it an input and one or more datasets from a curated example
    library, and watch it run. Understand an engine standalone before composing
    it in the Studio. The engine is headless; the component is the playground UI.
---

Every engine in this suite compiles a document and then runs it, and the
playground ([#/play](#/play)) is that pair made visible: one pane holds the
program (a schema, a path expression, a query document, a stylesheet), the others
hold the data it runs against, and the result card shows what the compiled
closure actually returned — the value, the normalized paths, the structured
errors with their stable msgids, or the compile refusal with the JSON Pointer of
the member at fault.

The package is two layers, like every component here. The engine is headless: a
registry of engines, each declaring its panes, its example datasets and how to
run one — no DOM, importable from a test or a script. The component layer is the
playground itself, an `@jarenjs/app` view stylesheet plus actions, which is why
the same playground can be hosted by this site, by the Studio, or by an
application of your own without either half knowing about the other.

The example library is part of the package, not of the website: a curated set per
engine, each one a document that runs. That is what makes the playground a
reference rather than a toy — the assistant reads the same library through its
schema-guarded tools, so "show me a JSLT stylesheet that does X" and the pane you
are looking at are the same source.

Two details worth knowing. The validate engine's data pane can switch to a
schema-generated form — the standard `@jarenjs/forms` stylesheet, validating per
keystroke against the very schema in the pane beside it. And the result card's
locale switcher re-renders the validator's errors in any of the shipped language
packs without re-validating anything: the errors carry msgids and params, and the
text is produced at report time.

**Try it.** [Open Play](#/play), pick an engine from the rail and edit either
pane — the run is live, and the URL carries the engine so a link lands where you
left it.
