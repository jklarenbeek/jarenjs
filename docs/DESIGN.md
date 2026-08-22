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
  **A packaged component's root is not a page.** `@jarenjs/studio`, `@jarenjs/play` and
  `@jarenjs/calc` render their own shell, and for as long as they were `$apply`ed straight
  into `<main>` they were the only surfaces on the site with no edge at all — flush to the
  screen on a phone, ignoring the 72rem column on a desktop. A component owns its markup;
  the *host* owns the page it is dropped into, so the `.page container` wrapper lives in
  `shell.js` (behind an `$if`, the way an absent `$apply` selector renders nothing) and
  never in the component. `packages/website/e2e/layout.spec.js` measures the edge against
  the header's own, per route, at both viewports.
- Prose containers that can receive arbitrary content (`.card p`, `.page-lead`, `.doc-p`,
  table cells) carry `overflow-wrap: anywhere` — long unbreakable tokens must never widen
  the page. In copy, prefer spaced slash lists (`a / b / c`) over `a/b/c`.
  **Exception, and it is load-bearing: cells inside a scrolling table revert to
  `overflow-wrap: normal`.** The rule exists to protect the *page*, and inside an
  `overflow-x` container the page is already protected — while `anywhere` there lets every
  column collapse to a single character, so the table never outgrows its wrapper, the
  scroll never engages, and a wide table crams instead of scrolling. See §9.
- **Ink over a concrete fill is derived from that fill, never inherited from the
  theme.** Any text set inside a colour the author or a palette chose — chart
  tiles, a mermaid `classDef` box — takes its colour from
  `inkFor(fill)` (`@jarenjs/core/color`), which picks by measured WCAG contrast
  and is swept over the whole RGB cube in `test/core/color.test.js` to
  guarantee AA (4.5:1). Inheriting the theme's text colour is the bug this
  prevents: a pale fill under a dark theme gets pale text and the label
  disappears into its own box. A theme-linked fill is the opposite case and
  keeps the theme's ink, because the two move together.
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
  intermediate breakpoints need a reason recorded here. The Flow studio's
  unrecorded **900 px** is gone: the one-pane block below owns that collapse
  now, at 1024 like everything else.
- **Grid tracks that hold arbitrary content are `minmax(0, 1fr)`, never bare `1fr`.**
  `1fr` means `minmax(auto, 1fr)`: the track can never shrink below its largest item's
  min-content width, so a single nowrap scroll strip inside it widens the whole page
  (the Docs 8×-viewport collapse). Scrollable children additionally carry
  `min-width: 0`. Belt-and-braces guard: `html, body { overflow-x: clip; }` (`clip`,
  not `hidden` — no scroll container, `position: sticky` keeps working).
- **A studio is a frame, not an article: above 1024 px it is exactly the viewport.**
  `.studio-page` (`#/project`, `#/play`) takes the leftover height and passes it down a
  chain of `min-height: 0` to the component root, so the rails and stages that already
  declare `overflow: auto` and `minmax(0, 1fr)` rows finally have something to scroll
  inside. The load-bearing part is that `.site` switches from `min-height` to a definite
  `height: 100dvh` when a studio page is present (`:has(> .main > .studio-page)`): a
  `min-height` shell still grows to whatever the tallest pane wants, which is the whole
  failure — Play's example rail drove the page to 2086px on a 900px viewport (every other
  pane a column of white) while the project IDE underfilled and stranded a 236px band
  above the footer. `.main` is the flex column that hands the height over; its children
  carry `width: 100%`, because a flex item with `margin-inline: auto` — which every
  `.container` has — opts out of stretching and silently narrows to fit-content.
  Below 1024 px the one-pane switcher takes over and the panes size to content, so the
  `min-width: 1025px` block is that block's complement, not a new breakpoint.
- **A sidebar taller than the viewport scrolls itself.** The docs rail (`.docs-side`,
  holding the section list *and* the README buttons) is capped at
  `calc(100dvh - 5.5rem)` with its own `overflow-y`. Uncapped, its 1907px drove the grid
  row next to a 297px article and one short section pushed the page past 2000px — and its
  `position: sticky` was decorative, since an element taller than the viewport can never
  stick. On mobile the rail is `display: contents` so its two halves place themselves as
  grid items and the README list is `order: 1` — **the article comes before the package
  list**; it used to sit twenty buttons below the fold.
- Mobile patterns (reuse these, don't invent siblings):
  - **One pane at a time** — the rule for every multi-pane studio
    (`#/play`, `#/project`, `#/flow`, `#/data`). Below 1024 px a studio never
    stacks its panes into a tall scroll: the grid becomes one column with a
    switcher row, a segmented bar picks the live pane, and the others are
    hidden in CSS. The protocol is three parts and all four surfaces
    implement all three:
    1. the pane container publishes the live pane as `data-pane`;
    2. a `…-panebar` bar of `.seg` / `.seg-btn` toggles sets it — `role="group"`
       with `aria-pressed`, **not** a `tablist` (a pane is a grid area, not a
       `tabpanel`; a real tab strip, like Play's result screens, does use
       `tablist`/`aria-selected`);
    3. the studio's stylesheet hides the unselected panes with
       `[data-pane='x'] .other-pane { display: none }`, and declares the bar's
       desktop `display: none` **immediately above** that media block —
       equal specificity means source order decides, so a `display: none`
       written further down silently beats the query.
    Two consequences worth keeping: the panes stay **mounted**, so a hidden
    editor keeps its caret, its scroll and its undo stack and a switch costs
    one attribute write rather than a re-render; and controls that divide a
    *two-pane* screen (drag splitters, the IDE's three-way layout switcher)
    are hidden here, because below the breakpoint they have nothing to do.
    Where a gesture's answer lives in another pane — picking an example, a
    file or a diagram node, pressing Run — the action carries the user
    across, which is invisible on desktop. The pane is host chrome and never
    a document member: it must not travel with a saved or shared document.
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
- **Wide figures scroll, they do not shrink.** The same rule as tables, one
  step further: an SVG capped at `max-width: 100%` scales to fit, which shrinks
  its text with it — on a phone a 14px diagram label lands near 11px. A diagram
  is laid out at a legible size, so it renders at that size and its figure
  scrolls (`@jarenjs/mermaid`'s `.md-mermaid.mermaid-block`). `svgRoot` writes
  its `max-width` inline, which outranks any stylesheet, so opting out is the
  `{ fit: false }` argument rather than a CSS override. Charts keep the fit:
  scaling a plot is fine, scaling prose is not.
- **Wide tables scroll, they do not cram.** A table is wrapped in `.table-scroll`
  (`overflow-x: auto` + `min-width: 0`), and its cells opt out of `overflow-wrap: anywhere`
  per §3. Both halves are required: the wrapper alone does nothing while the cells can
  shrink to one character. Note that a page-overflow assertion cannot catch the failure —
  a crammed table does not widen the page — so the evidence is internal
  (`wrapper.scrollWidth > wrapper.clientWidth`) plus a per-column floor, which is what
  `packages/website/e2e/tables.spec.js` asserts.
- A media-query override of a rule must appear **later in the file** than its base rule —
  media queries add no specificity (the `.docs-readmes` trap).

## 6. Accessibility & motion

- **One global focus style**: `:focus-visible { outline: 2px solid var(--accent); }` —
  no per-control focus rules, no outline suppression.
- All scroll/transition animation sits behind `@media (prefers-reduced-motion:
  no-preference)`, and `reduce` means **the final state at once** — never a shortened
  animation, never a slower one. A rule whose resting state needs a value of its own
  (the running machine's glow) states it in the base rule and adds only the movement
  behind the preference.
- **The motion vocabulary is one layer, tokenized** (the end of `styles.css`), so every
  surface moves with the same voice: `--motion-fast|base|slow` for duration,
  `--motion-stagger` for one step of a reveal wave, `--motion-rise` for the whole
  distance anything travels, and the easing pair `--motion-ease-out` (things arriving
  decelerate into place) / `--motion-ease-loop` (things that repeat breathe
  symmetrically). A new animation reaches for those tokens or it is not part of the
  system. Only `transform` and `opacity` animate, ever — animating a layout property
  costs a frame the compositor cannot give back.
- **Three families, and no fourth without a reason.**
  1. *Page entrance* — the shell keys `<main>` on the route, so a route swap MOUNTS the
     page container instead of patching the old one in place, and the entrance plays
     once per arrival (a reused element keeps the animation it already ran). CSS only.
  2. *Card reveal* — the site's card vocabulary rises in the first time it is scrolled
     to: `.reveal` is the pre-view state, `.reveal-in` the arrival, and
     `--motion-index` staggers a batch that arrives together.
  3. *Counted headline* — a measured line counts up to the value the renderer already
     wrote. Only the leading numeric token moves and the last frame restores the
     rendered string verbatim: the count borrows a published figure, it never formats
     one, and a string whose leading number is a date, a version or a grouped number is
     refused rather than rewritten.
- **The motion install lives at the committed-frame boundary** (`afterRender`, through a
  host capability the site injects), never in an effect and never in the view: an
  IntersectionObserver stamps the classes, CSS does the moving. Two guarantees ride on
  that split — a host with no DOM (every headless test) renders the final values and
  never learns motion exists, and content can never be lost to an animation: what the
  observer stamps, a settled-scroll sweep releases when a flick or an anchor jump moved
  the viewport past a card between two observation cycles.
- Disclosure toggles expose state declaratively (`aria-expanded` + `aria-controls` on the
  menu button). **No programmatic focus management from actions/effects**: the app's
  render is async-scheduled, so an effect touching the DOM races the patch — state must be
  expressed as attributes the renderer owns. DOM work that genuinely needs the committed
  frame (focus intents, scroll-into-view of the active tab) belongs in `afterRender`,
  the committed-frame boundary — never in an effect.
- Pronounceable labels over icon-only controls (`aria-label` on the menu/theme toggles).

## 7. Component theming architecture

Every SVG-emitting component (mermaid, calc plots, charts) themes in **two layers**,
resolved by the shared `resolveTheme` kernel (`@jarenjs/view/helpers`) behind each
component's `createTheme` — a one-line wrapper that supplies only what is genuinely the
component's own: its `THEMES` tables, its `--<prefix>-*` variable prefix and its
`HOST_VARS` link table:

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
  to §2 host token names; the component hands that table to `resolveTheme`, which owns the
  reserved `'host'` name so all three components resolve it identically. Generic form:
  `resolveTheme`'s overrides object takes a reserved `vars` key (`{ theme: 'dark',
  vars: {...} }` composes).
- The website passes `theme: 'host'` at every embed point: the md `mermaidPlugin`,
  `createMermaidComponent`, the calc viewmodel, and each charts entry
  (`createChartComponent`, `compileChart`, `createChartSession`). A new embed that
  omits it renders the component's own default palette instead of the site's, which
  is the one way an SVG component can visibly break the brand.

**HTML-level components** (calc chrome, md articles) are themed by stylesheet custom
properties, so the host *can* override them — but component CSS loads after site CSS, so a
site override must win ties with the component's own `.dark .x` block: use the doubled
selector **`.site .x, .dark .site .x`** (see the `.calc` and `.md` bridges in
`styles.css`).

Sync invariants: each themed component's `default` theme lives in **two** files that
must match — mermaid (`components/mermaid/src/theme.js` ↔ the `--mm-*` fallbacks in
`styles/mermaid.css`), calc (`theme.js` ↔ `styles/calc.css`) and charts
(`src/core/palette.js` ↔ the `--chart-*` fallbacks in `styles/charts.css`).

## 8. Chart & diagram palettes

- Categorical palettes (pie slices, plot series) are concrete constants, not theme tokens
  — and they obey §1: **no pink, no purple**. Anchor order: blue first, amber second,
  cyan/teal third, then green/red/slate/navy/olive/brown.
- Calc plot series: `series1` = accent blue, `series2` = cyan, `series3` = amber (all
  host-linked where a host token exists). 3-D surfaces shade within the blue family.
- Mermaid: nodes/actors = accent-soft fill + accent stroke; clusters = neutral
  surface/border; notes = amber (`--warn` family); the parse-error box = the
  `--fail`/`--fail-soft` family. Its tokens are named `err*` (`--mm-err-*`),
  not `error*`: every root stamps every token, and `mm-error` is the class
  that marks a root as an error box, so an `--mm-error-*` stamp would put
  that marker on every healthy diagram.

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
- **width is not the only way a page goes wrong.** A full-bleed page is exactly as wide as
  the viewport and a too-tall page is what scrolling is for, so neither of the two failures
  above shows up in an overflow assertion. The measurements that catch them are the page
  root's x against the header's own, and the studio frame's height against the viewport —
  `packages/website/e2e/layout.spec.js`, which fails on the pre-fix build in ten places;
- **motion is verified in both directions**, not by watching it: under an emulated
  `no-preference` a card reaches its final transform, a headline settles on exactly the
  string the renderer published, and a jumped scroll still leaves nothing invisible;
  under an emulated `reduce` every surface carries its final state on first paint with
  `animation-name: none` and a zero transition — `packages/website/e2e/motion.spec.js`,
  across all three engines;
- **the banned hues of §1 are a script**, not a command copied out of this page:
  `npm run test:design` scans the site's source **and** its built `dist/` for the
  historical offenders and exits non-zero on any hit, naming the file and the byte
  offset. The list of hues lives in `scripts/check-site-design.js` and nowhere else —
  a value written twice is a value that drifts — and a test asserts this document does
  not carry a copy of it. Build first (`npm run website:build`): a hue can arrive
  through a dependency's stylesheet and never appear in a file this repository wrote;
- `npm run lint`, `npm test`, and the dead-code audit stay green like any other change.

All of the above (plus the browser matrix) run together as `npm run site:gate`, which is
the one command a visual change must end green on.
