//@ts-check
/**
 * The published Jaren workspaces, each with the raw URL of its
 * README.md on the default branch. The docs page renders a "Read
 * README" button per entry; clicking one fetches the Markdown and
 * shows it — parsed and rendered by the @jarenjs/md visual component —
 * in the near-fullscreen dialog.
 */

/** The raw-content base every README (and README-relative doc) loads from. */
export const RAW = 'https://raw.githubusercontent.com/jklarenbeek/jarenjs/refs/heads/main';

/** The human-facing GitHub base for repo paths that are not Markdown. */
export const REPO = 'https://github.com/jklarenbeek/jarenjs';

/** @type {{ name: string, dir: string, blurb: string }[]} */
const ENTRIES = [
  { name: '@jarenjs/core', dir: 'packages/core', blurb: 'Zero-dependency foundation: type guards, Unicode strings, text validators, math.' },
  { name: '@jarenjs/json', dir: 'packages/json', blurb: 'Pointer, JSONPath, the JSON Query language, JSLT & JTLT stylesheets.' },
  { name: '@jarenjs/validate', dir: 'packages/validate', blurb: 'The JSON Schema validating compiler.' },
  { name: '@jarenjs/formats', dir: 'packages/formats', blurb: 'Format validators for the format keyword.' },
  { name: '@jarenjs/refs', dir: 'packages/refs', blurb: 'The official meta-schemas, bundled for offline use.' },
  { name: '@jarenjs/emit', dir: 'packages/emit', blurb: 'Your schemas as TypeScript: JSON Schema to .d.ts through JTLT stylesheets, verified against the validator itself.' },
  { name: '@jarenjs/forms', dir: 'packages/forms', blurb: 'Framework-agnostic form generation from JSON Schema.' },
  { name: '@jarenjs/locales', dir: 'packages/locales', blurb: 'Locale packs for validate & forms error messages.' },
  { name: '@jarenjs/view', dir: 'packages/view', blurb: 'The vnode format: UIs as JSON, a keyed DOM patcher and SSR.' },
  { name: '@jarenjs/app', dir: 'packages/app', blurb: 'Applications as JSON documents: the compiled dispatch loop.' },
  { name: '@jarenjs/md', dir: 'components/md', blurb: 'Markdown + frontmatter as JSON: the engine and this visual component.' },
  { name: '@jarenjs/mermaid', dir: 'components/mermaid', blurb: 'A native, headless Mermaid clone: diagrams-as-code to pure-vnode SVG.' },
  { name: '@jarenjs/calc', dir: 'components/calc', blurb: 'A multi-mode calculator with x·y/x·y·z plots — apps as JSON on a pure core kernel.' },
  { name: '@jarenjs/charts', dir: 'components/charts', blurb: 'Headless charts: definitions to geometry-free ASTs to pure-vnode SVG, streamable.' },
  { name: '@jarenjs/josl', dir: 'packages/josl', blurb: 'JOSL & JSONX: a streaming TOML superset, incremental JSON/JSONX readers, and a self-healing CSV reader/writer.' },
  { name: '@jarenjs/ai', dir: 'packages/ai', blurb: 'Browser-side AI: one OpenAI-compatible client (OpenRouter/Ollama/LM Studio), a Jaren-guarded tool registry, a bounded agent loop and WebMCP.' },
];

export const PACKAGES = ENTRIES.map((entry) => ({
  name: entry.name,
  blurb: entry.blurb,
  url: `${RAW}/${entry.dir}/README.md`,
}));
