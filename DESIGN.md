# DESIGN.md — visual design system & UI/UX constraints

The design constraints for the jarenjs website (`packages/website`) and every visual
component it embeds (`components/calc`, `components/md`, `components/mermaid`). This is a
**constraints document**: any change to the site's or a component's visuals must hold these
invariants. It is self-contained and committed; the source of truth for token *values* is
always the code (`packages/website/src/styles.css` and each component's `theme.js`/CSS).

## 1. Brand & color

- **The brand is blue**, anchored on the logo (`public/jaren.svg`, `#3b82f6`, hue ~217°).
- **No pink and no purple anywhere** — not in UI chrome, syntax highlighting, diagram
  themes, or chart palettes. Violet-family hues (~250–330°) are banned. When a warm accent
  is needed (notes, warnings, third chart series), use **amber** (`--warn` family).
- The CTA/interactive accent is **one step darker than the logo** — light `#2563eb`
  (blue-600), dark `#60a5fa` (blue-400) — because white text on the logo blue itself is
  only 3.68:1. The logo keeps `#3b82f6`; UI text/fills never use it as a text-bearing
  background.
- Status colors: green `--ok`, red `--fail`, amber `--warn` (+ `-soft` tints). These are
  semantic — never use a status hue decoratively.

### Contrast rules (WCAG AA is the floor)

- Text on the solid accent: **light mode** white on `#2563eb` (5.17:1); **dark mode**
  near-black navy `--accent-fg` on `#60a5fa` (7.45:1). **Never white text on the dark-mode
  accent** (~2.6:1). Any `background: var(--accent)` (or `--calc-accent`) must pair with
  `var(--accent-fg)` (/`--calc-accent-text`) — never a hardcoded `#fff`.
- The dark accent `#60a5fa` reads 7.2:1 against the dark `--bg` — safe as link/text color.

## 2. The site token vocabulary (the "host token contract")

`styles.css` `:root`/`.dark` define the complete vocabulary; everything else derives from
it. Components may *link* to these names (see §7), so they are a public contract:

| Token | Role |
|---|---|
| `--bg` / `--fg` | page background / body text |
| `--muted` | secondary text, soft strokes |
| `--surface` / `--border` | card fill / hairlines |
| `--accent` / `--accent-fg` / `--accent-soft` / `--accent-hover` | interactive blue, its text color, its tint, its hover step |
| `--ok`, `--fail`, `--warn` (+ `--ok-soft`, `--fail-soft`, `--warn-soft`) | semantic status + tints |
| `--code-bg` / `--code-fg` | code block colors (dark navy in both themes) |
| `--radius` (10px) / `--radius-sm` (8px) | cards & callouts / controls, inputs, code blocks |
| `--font` / `--mono` | Inter / JetBrains Mono stacks |
| `--space-1..14` | the spacing scale (§3) |

Rules: never hardcode a hex that duplicates a token's meaning; light/dark parity — every
token defined in `:root` is redefined in `.dark`; new hues enter as tokens or not at all.

## 3. Spacing, radii, layout

- **4 px-base spacing scale**: `--space-1` 0.25rem, `-2` 0.5, `-3` 0.75, `-4` 1,
  `-5` 1.25 (**the page gutter**), `-6` 1.5, `-8` 2, `-10` 2.5, `-14` 3.5.
- Component mapping conventions: cards/stat-cards/callouts `--space-4 --space-5`; buttons
  `--space-2 --space-4`; chips/tabs/small buttons `--space-1 --space-3`; section rhythm
  `--space-10`; page block padding `--space-8 --space-14`. Sub-step fine-tunes
  (< 0.25rem) are allowed only for hairline chrome (badge insets, chip nudges).
- **`.page` uses `padding-block`, never the `padding` shorthand.** An element can carry
  both `.page` and `.container`; the shorthand once zeroed the container's horizontal
  gutters on four pages. The same caution applies to any rule that may share an element
  with `.container`.
- One content edge: header, page content, and footer all align on the `--space-5` gutter
  (`max(var(--space-5), env(safe-area-inset-*))` for notched devices).
- Prose containers that can receive arbitrary content (`.card p`, `.page-lead`, `.doc-p`,
  table cells) carry `overflow-wrap: anywhere` — long unbreakable tokens must never widen
  the page. In copy, prefer spaced slash lists (`a / b / c`) over `a/b/c`.
- Radii: exactly two — `--radius` for cards/callouts/dialogs, `--radius-sm` for controls,
  inputs, editors, code blocks. No new literal radii above 6px.

## 4. Typography

- Families are **self-hosted** (`packages/website/public/fonts/`, latin woff2, OFL):
  Inter 400/600/700, JetBrains Mono 400/700. `font-display: swap`; the two 400 weights are
  preloaded in `index.html`; all five files are precached by `public/sw.js`.
- Four places must stay in sync when fonts change: the `@font-face` blocks in
  `styles.css`, the preloads in `index.html`, the files in `public/fonts/`, and the
  service-worker precache list (**bump the cache name** whenever a `public/` asset
  changes).
- Symbols used in chrome (☀ ☾ ✕ ☰) intentionally fall back per glyph to system fonts.

## 5. Responsiveness & mobile patterns

- Breakpoints: **1024 px** (two-column grids collapse or narrow before they cramp),
  **760 px** (mobile), and one recorded exception, **360 px** (very narrow phones: the
  docs README buttons drop from 2-up to full rows so they stay tappable). New
  intermediate breakpoints need a reason recorded here.
- **Grid tracks that hold arbitrary content are `minmax(0, 1fr)`, never bare `1fr`.**
  `1fr` means `minmax(auto, 1fr)`: the track can never shrink below its largest item's
  min-content width, so a single nowrap scroll strip inside it widens the whole page
  (the Docs 8×-viewport collapse). Scrollable children additionally carry
  `min-width: 0`. Belt-and-braces guard: `html, body { overflow-x: clip; }` (`clip`,
  not `hidden` — no scroll container, `position: sticky` keeps working).
- Mobile patterns (reuse these, don't invent siblings):
  - **Scroll strip**: tab bars and the docs section list become a single
    non-wrapping horizontally scrollable row, bled edge-to-edge with
    `margin-inline: calc(-1 * var(--space-5)); padding-inline: var(--space-5)` so the
    first item still aligns to the gutter. (Only valid because `.page` keeps its
    gutters — and only inside a `minmax(0, 1fr)` track, per the rule above.) Strips
    carry the affordance pair: a right edge fade
    (`mask-image: linear-gradient(90deg, #000 92%, transparent)`) and
    `scroll-padding-inline: var(--space-5)`; the app keeps the active item in view
    per committed frame (the `revealActiveTab` host capability in `afterRender`).
  - **2-up grids**: stat cards and the docs README buttons go
    `minmax(0, 1fr) minmax(0, 1fr)`, never one-per-row towers (README buttons
    excepted below 360 px, above).
  - **Full-screen sheet dialog**: at ≤ 760 px the README dialog fills the dynamic
    viewport (`100dvw/100dvh`, with a `vw/vh` fallback line before it), drops border
    and radius, pads its head by `env(safe-area-inset-top)`, and contains its scroll
    (`overscroll-behavior: contain`). While open, the app's `lock-scroll` effect sets
    `body.dialog-open { overflow: hidden; }` — the page never scrolls under a modal.
  - Touch targets, two tiers: dense in-flow chrome (chips, segments, tabs) ≥ `2.2rem`;
    primary tap targets — the header toggles, the dialog close, docs section links,
    README rows, and the assistant launcher and panel icons — ≥ `2.75rem`
    (the WCAG 2.5.8 / 44 px class).
- Long-form content discipline: tables, SVG and images inside articles and the README
  dialog carry `max-width: 100%`; README tables scroll internally
  (`display: block; overflow-x: auto`); anchored headings carry
  `scroll-margin-top: 4.5rem` so section links land below the sticky header.
- A media-query override of a rule must appear **later in the file** than its base rule —
  media queries add no specificity (the `.docs-readmes` trap).

## 6. Accessibility & motion

- **One global focus style**: `:focus-visible { outline: 2px solid var(--accent); }` —
  no per-control focus rules, no outline suppression.
- All scroll/transition animation sits behind `@media (prefers-reduced-motion:
  no-preference)`.
- Disclosure toggles expose state declaratively (`aria-expanded` + `aria-controls` on the
  menu button). **No programmatic focus management from actions/effects**: the app's
  render is async-scheduled, so an effect touching the DOM races the patch — state must be
  expressed as attributes the renderer owns. DOM work that genuinely needs the committed
  frame (focus intents, scroll-into-view of the active tab) belongs in `afterRender`,
  the committed-frame boundary — never in an effect.
- Pronounceable labels over icon-only controls (`aria-label` on the menu/theme toggles).

## 7. Component theming architecture

Every SVG-emitting component (mermaid, calc plots) themes in **two layers**, resolved by
the shared `resolveTheme` kernel (`@jarenjs/view/helpers`) behind each component's
`createTheme`:

1. **Concrete presentation attributes** on every shape — `toSvgString()` is a valid,
   self-colored standalone image with no CSS at all.
2. **Inline `--<prefix>-*` custom properties** stamped on the root `<svg>` (`--mm-*`,
   `--calc-*`) plus a class per shape; the component stylesheet maps classes to
   `var(--<prefix>-*)`, and CSS declarations beat presentation attributes.

**Cascade truth (load-bearing):** the stamp is an *inline style*, and inline custom
properties beat every stylesheet rule. A stylesheet can therefore never re-theme a stamped
SVG by redefining `--mm-*`/`--calc-*` — the stamp itself is the only hook. Re-theming goes
through **host-linked themes**:

- `createTheme('host')` (any component) resolves the default tokens but stamps each linked
  variable as `var(--<host-token>, <concrete fallback>)` — e.g.
  `--mm-node-fill: var(--accent-soft, #dbeafe)`. Inside the site the value tracks the host
  token **live** (light/dark flips need no re-render — memoized vnodes stay valid);
  standalone, the fallback keeps the default theme.
- The link tables are each component's `HOST_VARS` (in its `theme.js`), mapping token keys
  to §2 host token names. Generic form: `resolveTheme`'s overrides object takes a reserved
  `vars` key (`{ theme: 'dark', vars: {...} }` composes).
- The website passes `theme: 'host'` at its three embed points: the md `mermaidPlugin`,
  `createMermaidComponent`, and the calc viewmodel.

**HTML-level components** (calc chrome, md articles) are themed by stylesheet custom
properties, so the host *can* override them — but component CSS loads after site CSS, so a
site override must win ties with the component's own `.dark .x` block: use the doubled
selector **`.site .x, .dark .site .x`** (see the `.calc` and `.md` bridges in
`styles.css`).

Sync invariants: the mermaid `default` theme lives in **two** files that must match —
`components/mermaid/src/theme.js` and the `--mm-*` fallbacks in `styles/mermaid.css`.
Same for calc (`theme.js` ↔ `styles/calc.css`).

## 8. Chart & diagram palettes

- Categorical palettes (pie slices, plot series) are concrete constants, not theme tokens
  — and they obey §1: **no pink, no purple**. Anchor order: blue first, amber second,
  cyan/teal third, then green/red/slate/navy/olive/brown.
- Calc plot series: `series1` = accent blue, `series2` = cyan, `series3` = amber (all
  host-linked where a host token exists). 3-D surfaces shade within the blue family.
- Mermaid: nodes/actors = accent-soft fill + accent stroke; clusters = neutral
  surface/border; notes = amber (`--warn` family).

## 9. Browser chrome & PWA

- `index.html` carries **two** `theme-color` metas (light `#2563eb`, dark `#11141c`);
  the manifest matches (`theme_color` `#2563eb`, `background_color` `#ffffff`). These
  must move together with any accent change.
- The service worker precaches the app shell, icons, and fonts; **any change to a
  `public/` asset requires bumping the `CACHE` name** in `sw.js` or clients keep the old
  bytes.

## 10. Verification method

A visual pass is verified the way the original audit was made:

- production build (`npm run website:build`), rendered at **390×844 and 1280×900**, light
  and dark;
- `document.scrollingElement.scrollWidth` must equal the viewport width (no horizontal
  overflow);
- computed `padding` of `.page.container` elements must keep the horizontal gutter;
  Home's `h1` and every other page's `h1` must share the same x-offset;
- grep the built `dist/` for banned hues (the historical offenders):
  `5646d6|473bce|7f75f0|4f46e5|db2777|f472b6|ECECFF|9370DB|a626a4|c678dd|b07aa1|ff9da7|hsl(245`
  — zero hits required;
- `npm run lint`, `npm test`, and the dead-code audit stay green like any other change.
