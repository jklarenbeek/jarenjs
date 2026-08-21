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
import { md, mdArticle, rewriteReadmeLinks, readmeUrl } from '../boundaries/markdown.js';
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
import { formatRatio, memo1 } from '../lib/format.js';
import { callout } from '../lib/nodes.js';

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
    { page: 'project', label: 'Studio', href: '#/project' },
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
  markdown: 'markdown', mermaid: 'mermaid', contract: 'contract',
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
  if (page === 'project') {
    ui.project = { ...projectComponent.viewModel({ project: state.project }), templates: PROJECT_TEMPLATE_CARDS };
    // the site's save/share bar (the IDE store) renders above the IDE shell
    ui.projectIde = ideModel(state.ide.name, state.ide.names, state.ide.shared);
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
  if (page === 'docs') {
    ui.docs = docsPage(state.route.params.s,
      state.site.data.packages, state.site.status.packages);
  }
  if (page === 'calculator') ui.calculator = contributeCalcViewModel(state, { theme: 'host' });

  // The README dialog is a global overlay (any page can open it): it
  // only materializes when open, so the shell's $apply renders nothing
  // otherwise. `md.view` memoizes the article by source string, so a
  // re-render with the same README returns the same vnode reference.
  if (state.readme.open) ui.readme = readmeOverlay(state.readme);

  // The AI assistant is a global slide-out on every page.
  ui.assistant = assistantView(state.ai);

  // The footer's provenance line, likewise global — but only once the
  // generated file has landed: a page that cannot say which revision it
  // is says nothing rather than guessing.
  const build = state.site.data.build;
  if (build !== undefined) ui.build = buildLine(build);

  return { ...state, ui };
}

/**
 * The footer's one line of build provenance, from the file the build
 * generated: which version, which revision, and the date of the commit
 * it was built from (not the build's own clock). A checkout with no git
 * has no revision to name and the line simply omits it. The title
 * carries the build-environment facts — the runtime and machine — and
 * says when the bundle carried uncommitted work, because "v0.38.0"
 * alone would claim a revision the reader could not reproduce.
 */
const buildLine = memo1((build) => {
  const parts = [`v${build.version}`];
  if (typeof build.commit === 'string') parts.push(build.commit.slice(0, 7));
  parts.push(`built ${String(build.built).slice(0, 10)}`);
  return {
    text: parts.join(' · '),
    title: `Built on ${build.node} (${build.platform})`
      + (build.reproducible ? '' : ' from a modified working tree'),
  };
});

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
      : { role: 'assistant', article: mdArticle(md.view(m.content)) })),
    // the reply currently streaming in (plain text: it changes per token)
    streaming: ai.status === 'streaming',
    pending: ai.pending,
    // the quiet-phase label: reasoning models think before they speak,
    // and watching the thinking grow beats a blind spinner
    thinkingLabel: ai.reasoningChars > 0
      ? `Thinking… (${ai.reasoningChars} characters of reasoning)`
      : 'Thinking…',
    // the ledger: a persistent objective, what has been recorded against
    // it, and what a compacted session can still reach. Every number here
    // is derived from the ledger read, so the panel cannot claim a
    // memory the store does not hold.
    goal: ai.goal === null ? null : {
      objective: ai.goal.objective,
      entries: ai.goal.progress.length,
      // newest first: the last thing that happened is the thing a reader
      // wants, and the whole log would push the conversation off screen
      progress: [...ai.goal.progress].reverse().slice(0, PROGRESS_SHOWN)
        .map((entry) => ({ note: entry.note, evidence: entry.evidence })),
      more: Math.max(0, ai.goal.progress.length - PROGRESS_SHOWN),
    },
    goalDraft: ai.goalDraft,
    memories: ai.memories,
    memoryLabel: `${ai.memories} remembered fact${ai.memories === 1 ? '' : 's'}`,
    archived: ai.archived,
    // said in full sentences, because "12" beside a chat is not
    // information: a compacted session has to LOOK recoverable
    archivedLabel: `${ai.archived} earlier round${ai.archived === 1 ? '' : 's'} archived —`
      + ' the assistant can fetch any of them back with recall.',
    remembering: ai.remembering,
    remembered: ai.remembered,
  };
});

/** Progress entries the panel shows before it says "and N more". */
const PROGRESS_SHOWN = 3;

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

// keyed on the slices deriveSuite actually reads — never the state
// root, which is fresh every transition and would defeat the memo
const benchNodes = memo1((suite, data, status, benchUi, unknown) => {
  const need = suite === 'overview' ? 'meta' : suite;
  const nodes = deriveSuite({ bench: { [need]: data }, benchStatus: { [need]: status }, benchUi }, suite);
  return unknown === null ? nodes : [
    callout('No such suite', `There is no benchmark suite named '${unknown}' — showing the overview instead.`),
    ...nodes,
  ];
});

const composeBench = memo1((suites, nodes) => ({ suites, nodes }));

const chartsPage = (state) => composeChartsPage(state.chartsLive);
const composeChartsPage = memo1((live) => ({
  live: live ?? binanceInvitation(),
  demos: [...chartsPageDemos(), chartsPageStreamingCallout()],
}));

function benchPage(state) {
  // an unknown ?suite= shows the overview plus an honest callout (the
  // route/set gate never fetched for it, so nothing is loading either)
  const requested = state.route.params.suite ?? 'overview';
  const known = SUITES.some((s) => s.key === requested);
  const suite = known ? requested : 'overview';
  const need = suite === 'overview' ? 'meta' : suite;
  return composeBench(
    benchTabs(suite),
    benchNodes(suite, state.bench[need], state.benchStatus[need], state.benchUi,
      known ? null : requested));
}

/** The Project IDE-bar model (name field, share status, saved chips). */
const ideModel = memo1((name, names, shared) => ({
  name,
  shared,
  names: names.map((n) => ({ name: n })),
}));

const docsPage = memo1((param, census, status) => {
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
    ...readmeRail(census, status),
  };
});

/**
 * The README rail: one button per PUBLISHED workspace, from the census
 * the build derives from the workspace manifests. The site keeps no list
 * of its own, because a hand-kept copy drifts from the repository it
 * describes — so until the census lands the rail says what it is waiting
 * for, exactly as the benchmarks page does with its data.
 * @param {any} census - The generated census, or undefined.
 * @param {string | undefined} status
 */
function readmeRail(census, status) {
  if (census === undefined) {
    return {
      packages: [],
      note: status === 'error'
        ? callout('Package list unavailable',
          'The package census could not be loaded. The site build generates it from the workspace manifests.')
        : callout('Loading…', 'Fetching the package census.'),
    };
  }
  return {
    packages: census.packages.map((entry) => ({
      name: entry.name,
      blurb: entry.description,
      url: readmeUrl(entry.dir),
    })),
  };
}
