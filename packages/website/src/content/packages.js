//@ts-check
/**
 * The published Jaren workspaces, each with the raw URL of its
 * README.md on the default branch. The docs page renders a "Read
 * README" button per entry; clicking one fetches the Markdown and
 * shows it — parsed and rendered by the @jarenjs/md visual component —
 * in the near-fullscreen dialog.
 */

const RAW = 'https://raw.githubusercontent.com/jklarenbeek/jarenjs/refs/heads/main';

/** @type {{ name: string, dir: string, blurb: string }[]} */
const ENTRIES = [
  { name: '@jarenjs/core', dir: 'packages/core', blurb: 'Zero-dependency foundation: type guards, Unicode strings, text validators, math.' },
  { name: '@jarenjs/json', dir: 'packages/json', blurb: 'Pointer, JSONPath, the JSON Query language, JSLT & JTLT stylesheets.' },
  { name: '@jarenjs/validate', dir: 'packages/validate', blurb: 'The JSON Schema validating compiler.' },
  { name: '@jarenjs/formats', dir: 'packages/formats', blurb: 'Format validators for the format keyword.' },
  { name: '@jarenjs/refs', dir: 'packages/refs', blurb: 'The official meta-schemas, bundled for offline use.' },
  { name: '@jarenjs/forms', dir: 'packages/forms', blurb: 'Framework-agnostic form generation from JSON Schema.' },
  { name: '@jarenjs/locales', dir: 'packages/locales', blurb: 'Locale packs for validate & forms error messages.' },
  { name: '@jarenjs/view', dir: 'packages/view', blurb: 'The vnode format: UIs as JSON, a keyed DOM patcher and SSR.' },
  { name: '@jarenjs/app', dir: 'packages/app', blurb: 'Applications as JSON documents: the compiled dispatch loop.' },
  { name: '@jarenjs/md', dir: 'components/md', blurb: 'Markdown + frontmatter as JSON: the engine and this visual component.' },
  { name: '@jarenjs/josl', dir: 'packages/josl', blurb: 'JOSL & JSONX: a streaming TOML superset (research).' },
];

export const PACKAGES = ENTRIES.map((entry) => ({
  name: entry.name,
  blurb: entry.blurb,
  url: `${RAW}/${entry.dir}/README.md`,
}));
