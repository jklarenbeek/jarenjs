//@ts-check
/**
 * The derivation boundary (APP-FORMAT §5.2): state in, the view
 * stylesheet's input document out, once per render. Only the ACTIVE
 * page's node exists under `$.ui` — the shell `$apply`s every page
 * member and absent members select nothing, so page switching needs no
 * conditionals in the stylesheet.
 */

import { deriveSuite, SUITES } from '../boundaries/bench.js';
import { formViewFor } from '../boundaries/validator.js';
import { HOME_CONTENT } from '../content/home.js';
import { DOCS_SECTIONS } from '../content/docs.js';
import { PACKAGES } from '../content/packages.js';
import { md, rewriteReadmeLinks } from '../boundaries/markdown.js';
import { chartsPageDemos, chartsPageStreamingCallout } from '../boundaries/chartspage.js';
import { binanceInvitation } from '../boundaries/binance.js';
import { contributeCalcViewModel } from '@jarenjs/calc/component';
import { PROVIDER_OPTIONS, isConfigured } from '../boundaries/assistant.js';
import { flowPageViewModel } from '../boundaries/flowstudio.js';
import { projectComponent } from '../boundaries/project.js';
import { PROJECT_TEMPLATE_CARDS } from '../content/projectTemplates.js';
import { playComponent } from '../boundaries/play.js';
import { gamePageViewModel } from '../boundaries/game.js';
import { dataViewModel } from '../boundaries/data.js';
import { STUDIO_TEMPLATES } from '../content/appTemplates.js';
import { callout, error } from '../lib/nodes.js';
import { formatJson, formatRatio, memo1 } from '../lib/format.js';

// the nav is grouped into three dropdown menus by what each surface IS:
// stateless ENGINES you tinker with, stateful STUDIOS you compose in, and
// LEARN (the read/measure pages). Home stands alone before the groups.
const HOME_LINK = { page: 'home', label: 'Home', href: '#/' };
const NAV_GROUPS = [
  { key: 'engines', label: 'Engines', pages: [
    { page: 'play', label: 'Play', href: '#/play' },
    { page: 'charts', label: 'Charts', href: '#/charts' },
  ] },
  { key: 'studios', label: 'Studios', pages: [
    { page: 'studio', label: 'Studio', href: '#/studio' },
    { page: 'flow', label: 'Flow', href: '#/flow' },
    { page: 'data', label: 'Data', href: '#/data' },
    { page: 'game', label: 'Game', href: '#/game' },
    { page: 'calculator', label: 'Calculator', href: '#/calculator' },
  ] },
  { key: 'learn', label: 'Learn', pages: [
    { page: 'docs', label: 'Docs', href: '#/docs' },
    { page: 'benchmarks', label: 'Benchmarks', href: '#/benchmarks' },
  ] },
];

/** Home engine card → the benchmark headline that measures it. */
const HOME_ENGINE_SUITE = {
  validate: 'validate', path: 'jsonpath', pointer: 'jsonpointer', patch: 'jsonpatch',
  query: 'jsonquery', jslt: 'jslt', josl: 'toml', csv: 'csv', charts: 'charts',
  markdown: 'markdown', mermaid: 'mermaid',
};

/**
 * The home content with its performance line taken from the generated
 * benchmark run rather than from prose. A card whose engine has a
 * headline shows that run's measured ratio; everything else — and the
 * whole page before `meta.json` arrives, or if it fails to — keeps the
 * static line, which is why those stay claims that cannot go stale.
 * @param {any} state
 * @returns {any}
 */
function homeContent(state) {
  const headlines = state.bench?.meta?.headlines;
  if (!Array.isArray(headlines) || headlines.length === 0) return HOME_CONTENT;
  const byKey = new Map(headlines.map((h) => [h.key, h]));
  return {
    ...HOME_CONTENT,
    engines: HOME_CONTENT.engines.map((engine) => {
      const headline = byKey.get(HOME_ENGINE_SUITE[engine.key]);
      if (headline === undefined || !Number.isFinite(headline.ratio)) return engine;
      // formatRatio names the direction, so a sub-parity suite reads
      // "2.3× slower than …" rather than the cryptic "0.4× vs …"
      const speed = `${formatRatio(headline.ratio)} than ${headline.rival}`;
      return {
        ...engine,
        perf: headline.conformance
          ? `${headline.conformance} conformance · ${speed}`
          : speed,
      };
    }),
  };
}

/**
 * @param {any} state
 * @returns {any} the view input document
 */
export function viewModel(state) {
  const page = state.route.page;
  /** @type {any} */
  const ui = { nav: deriveNav(page, state.navOpen) };

  if (page === 'home') ui.home = homeContent(state);
  if (page === 'benchmarks') ui.bench = benchPage(state);
  if (page === 'charts') ui.chartsPage = chartsPage(state);
  if (page === 'studio') ui.studio = studioPage(state);
  if (page === 'project') {
    ui.project = { ...projectComponent.viewModel({ project: state.project }), templates: PROJECT_TEMPLATE_CARDS };
  }
  if (page === 'play') {
    ui.play = playComponent.viewModel({ play: state.play });
    // the validate engine's data pane can toggle to a schema-generated form;
    // the form tree is built here (it needs @jarenjs/forms, a host dep) from
    // the schema source + the structured buffer, and mounted at `dataForm`
    if (state.play.engine === 'validate' && state.play.dataView === 'form') {
      ui.play.dataForm = formViewFor(state.play.source?.schema ?? '', state.play.dataValue);
    }
  }
  if (page === 'flow') ui.flow = flowPageViewModel(state.flow);
  if (page === 'game') ui.game = gamePageViewModel(state.game);
  if (page === 'data') ui.data = dataViewModel(state);
  if (page === 'docs') ui.docs = docsPage(state.route.params.s);
  if (page === 'calculator') ui.calculator = contributeCalcViewModel(state, { theme: 'host' });

  // The README dialog is a global overlay (any page can open it): it
  // only materializes when open, so the shell's $apply renders nothing
  // otherwise. `md.view` memoizes the article by source string, so a
  // re-render with the same README returns the same vnode reference.
  if (state.readme.open) ui.readme = readmeOverlay(state.readme);

  // The AI assistant is a global slide-out on every page.
  ui.assistant = assistantView(state.ai);

  return { ...state, ui };
}

const assistantView = memo1((ai) => {
  const s = ai.settings;
  const configured = isConfigured(s);
  return {
    open: ai.open,
    status: ai.status,
    activity: ai.activity,
    error: ai.error,
    draft: ai.draft,
    configured,
    // the settings form shows until the assistant can actually run, or
    // whenever the user opens it explicitly
    showSettings: ai.settingsOpen || !configured,
    settings: {
      provider: s.provider,
      baseUrl: s.baseUrl,
      model: s.model,
      apiKey: s.apiKey,
      needsKey: s.provider === 'openrouter' || s.provider === 'custom',
      probe: {
        status: ai.probe.status,
        detail: ai.probe.detail,
        busy: ai.probe.status === 'busy',
        ok: ai.probe.status === 'ok',
        fail: ai.probe.status === 'fail',
        models: ai.probe.models.map((id) => ({ id })),
      },
    },
    providers: PROVIDER_OPTIONS.map((p) => ({ ...p, selected: p.value === s.provider })),
    empty: ai.messages.length === 0,
    messages: ai.messages.map((m) => (m.role === 'user'
      ? { role: 'user', text: m.content }
      : { role: 'assistant', article: md.view(m.content) })),
    // the reply currently streaming in (plain text: it changes per token)
    streaming: ai.status === 'streaming',
    pending: ai.pending,
    // the quiet-phase label: reasoning models think before they speak,
    // and watching the thinking grow beats a blind spinner
    thinkingLabel: ai.reasoningChars > 0
      ? `Thinking… (${ai.reasoningChars} characters of reasoning)`
      : 'Thinking…',
  };
});

const readmeOverlay = memo1((readme) => ({
  title: readme.title,
  status: readme.status,
  message: readme.message,
  canBack: readme.at > 0,
  canForward: readme.at < readme.stack.length - 1,
  // repo-relative links inside the article navigate the dialog itself
  article: readme.source !== null
    ? rewriteReadmeLinks(md.view(readme.source), readme.url)
    : null,
}));

/** The nav model: a standalone Home link + three dropdown groups, each with
 * an `open` flag (from state.navOpen) and an `active` flag (the current page
 * lives in it). Cheap, so not memoized — it must recompute when navOpen
 * changes, which a page-only memo key would miss. */
function deriveNav(page, navOpen) {
  return {
    home: { ...HOME_LINK, active: page === 'home' },
    groups: NAV_GROUPS.map((g) => ({
      key: g.key,
      label: g.label,
      open: navOpen === g.key,
      active: g.pages.some((p) => p.page === page),
      items: g.pages.map((p) => ({ ...p, active: p.page === page })),
    })),
  };
}

const benchTabs = memo1((suite) => SUITES.map((s) => ({
  ...s,
  active: s.key === suite,
  href: `#/benchmarks?suite=${s.key}`,
})));

const benchNodes = memo1((suite, data, status, benchUi, state) =>
  deriveSuite(state, suite));

const composeBench = memo1((suites, nodes) => ({ suites, nodes }));

const chartsPage = (state) => composeChartsPage(state.chartsLive);
const composeChartsPage = memo1((live) => ({
  live: live ?? binanceInvitation(),
  demos: [...chartsPageDemos(), chartsPageStreamingCallout()],
}));

function benchPage(state) {
  const suite = state.route.params.suite ?? 'overview';
  const need = suite === 'overview' ? 'meta' : suite;
  return composeBench(
    benchTabs(suite),
    benchNodes(suite, state.bench[need], state.benchStatus[need], state.benchUi, state));
}

/** The Studio's IDE-bar model (name field, share status, saved chips). */
const ideModel = memo1((name, names, shared) => ({
  name,
  shared,
  names: names.map((n) => ({ name: n })),
}));

// ---- the Studio ----

/** The picker cards: constant content, computed once. */
const STUDIO_PICKER = {
  templates: STUDIO_TEMPLATES.map((t) => ({
    name: t.name,
    title: t.title,
    lead: t.lead,
    preview: formatJson(t.doc).split('\n').slice(0, 14).join('\n') + '\n…',
  })),
};

/** The host-widget props: reference-stable per (doc, revision). */
const studioMount = memo1((doc, revision) => ({ doc, revision }));

const studioEditorText = memo1((doc) => formatJson(doc));

/** A failed validation report as the site's standard error nodes. */
const studioErrorNodes = memo1((errors) => {
  if (errors === null) return [];
  const nodes = errors.list.map((e) => error({
    message: e.message,
    dataPath: e.instancePath,
    code: e.keyword !== '' ? e.keyword : undefined,
  }, 'Schema error'));
  if (errors.total > errors.list.length) {
    nodes.push(callout('More errors', `${errors.total - errors.list.length} further meta-schema errors were truncated — fix the ones above first.`));
  }
  return nodes;
});

const composeStudioLive = memo1((editorText, revision, bootError, ide, mount) => ({
  editorText,
  revision,
  error: bootError,
  ide,
  mount,
}));

// the validation report renders at page level: a failed editor commit
// (or an invalid inbound share) reports whether or not a document is
// currently live — the old document stays mounted underneath
const composeStudioPage = memo1((live, errorNodes) => ({
  ...(live === null ? { picker: STUDIO_PICKER } : { live }),
  errors: errorNodes,
  hasErrors: errorNodes.length > 0,
}));

function studioPage(state) {
  const s = state.studio;
  const live = s.doc === null ? null : composeStudioLive(
    studioEditorText(s.doc), s.revision, s.error,
    ideModel(state.ide.name, state.ide.names, state.ide.shared),
    studioMount(s.doc, s.revision));
  return composeStudioPage(live, studioErrorNodes(s.errors));
}

const docsPage = memo1((param) => {
  const current = param ?? DOCS_SECTIONS[0].id;
  const section = DOCS_SECTIONS.find((s) => s.id === current) ?? DOCS_SECTIONS[0];
  return {
    sections: DOCS_SECTIONS.map((s) => ({
      id: s.id,
      title: s.title,
      active: s.id === section.id,
      href: `#/docs?s=${s.id}`,
    })),
    section: { title: section.title, blocks: section.blocks },
    packages: PACKAGES,
  };
});
