//@ts-check
/**
 * The derivation boundary (APP-FORMAT §5.2): state in, the view
 * stylesheet's input document out, once per render. Only the ACTIVE
 * page's node exists under `$.ui` — the shell `$apply`s every page
 * member and absent members select nothing, so page switching needs no
 * conditionals in the stylesheet.
 */

import { deriveSuite, draftConformanceTable, SUITES } from '../boundaries/bench.js';
import { formViewFor } from '../boundaries/validator.js';
import { HOME_CONTENT } from '../content/home.js';
import { HERO_DEMO } from '../content/hero.js';
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
import { siteContractNodes } from '../boundaries/site.js';
import { formatRatio, memo1 } from '../lib/format.js';
import { article, callout } from '../lib/nodes.js';

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

/** A pass/total score — the shape that earns the word "conformance". */
const SCORE = /^\d+ \/ \d+$/;

/**
 * One card's measured line: the run's ratio, named in the direction it
 * fell, behind whatever the suite scored. A headline's `conformance` is
 * a pass/total pair for the suites with an official corpus and a short
 * prose note for the rest ("1 statement", "serializable"), so the word
 * is added only where it is the truth.
 */
function perfLine(headline) {
  const speed = `${formatRatio(headline.ratio)} than ${headline.rival}`;
  const score = headline.conformance;
  if (typeof score !== 'string' || score === '') return speed;
  return SCORE.test(score) ? `${score} conformance · ${speed}` : `${score} · ${speed}`;
}

/**
 * The engine grid, entirely from the site documents the workspaces
 * commit: every card is the words a package wrote about its own engine,
 * in census order, and a package that publishes several engines (the
 * addressing engines of @jarenjs/json, the JOSL and CSV readers)
 * contributes one card each. The website authors none of them — which
 * is why a new engine reaches this page in its own package's commit.
 * @param {any} content - The collected site content, or undefined.
 * @returns {any[]}
 */
const engineCards = memo1((content) => (content?.packages ?? [])
  .flatMap((/** @type {any} */ entry) => entry.engines
    .map((/** @type {any} */ engine) => ({
      key: engine.key,
      suite: engine.suite,
      title: engine.card.title,
      blurb: engine.card.blurb,
      perf: engine.card.perf ?? '',
    }))));

/**
 * The home content with every measurable claim taken from the generated
 * benchmark run rather than from prose: the hero's conformance bullet
 * and each card's performance line, from the suite the package's own
 * document names. A card whose engine has no headline keeps its
 * authored line — and the grammar refuses a figure in one, so nothing
 * on this page can be a number that stopped being true. Before
 * `meta.json` arrives, or if it fails to, the authored cards render as
 * their packages wrote them.
 * @param {any} state
 * @returns {any}
 */
const homeContent = (state) => withDispatch(
  composeHome(engineCards(state.site.data.content),
    state.bench?.meta?.headlines, state.site.status.content),
  heroDemo(state.hero));

/** Both halves are memoized, so the merge is too — and the JSLT memo
 * keeps firing for the grid subtree while the hero re-dispatches. */
const withDispatch = memo1((home, dispatch) => ({ ...home, dispatch }));

/**
 * The living hero, as the page shows it: the recorded stages of a real
 * dispatch, one of them focused. Every line under `stages` was written
 * by the run itself (`boundaries/hero.js`) — this only decides what is
 * on screen, which member is expanded, and what to say while nothing
 * has settled yet. A member that has no answer is OMITTED rather than
 * nulled: the stylesheet `$apply`s it, and an absent member selects
 * nothing.
 */
const heroDemo = memo1((hero) => {
  const run = hero.run;
  const stages = run === null ? [] : run.stages.map((stage, index) => ({
    ...stage, index, focused: index === hero.focus,
  }));
  /** @type {any} */
  const view = {
    ...HERO_DEMO,
    input: hero.input,
    variant: hero.variant,
    revision: String(hero.revision),
    stages,
    status: statusLine(hero.status, run),
  };
  const focused = stages.find((stage) => stage.focused);
  if (focused !== undefined && focused.artifact !== null) view.focused = focused;
  if (run !== null && run.refusal !== null) {
    view.refusal = callout('Nothing dispatched', `The input is not a JSON document: ${run.refusal}`);
  }
  // the demo document's own identity, and the digest over its public
  // projection — the same revision any other consumer of it would compute
  if (run !== null && run.revision !== null) {
    view.identity = { ...run.document, binding: run.binding, revision: run.revision };
  }
  return view;
});

/** What the controls say about the run beside them, from the run. */
function statusLine(status, run) {
  if (status !== 'ready' || run === null) return status === 'running' ? 'dispatching…' : '';
  if (run.refusal !== null) return 'nothing dispatched';
  return `${run.binding} binding · output validation ${run.validatedOutput ? 'on' : 'off'}`;
}

const composeHome = memo1((engines, headlines, status) => {
  // the grid is fetched, so the page renders before it exists: say what
  // it is waiting for, exactly as the docs rail does with its census —
  // an empty grid under "One stack, 0 engines" would be a lie told for
  // one frame
  if (engines.length === 0) return { ...HOME_CONTENT, enginesNote: gridNote(status) };
  const byKey = new Map(Array.isArray(headlines) ? headlines.map((h) => [h.key, h]) : []);
  return {
    ...HOME_CONTENT,
    hero: byKey.size === 0 ? HOME_CONTENT.hero : heroWith(HOME_CONTENT.hero, byKey.get('validate')),
    grid: {
      engines: engines.map((engine) => {
        const headline = byKey.get(engine.suite);
        if (headline === undefined || !Number.isFinite(headline.ratio)) return engine;
        // formatRatio names the direction, so a sub-parity suite reads
        // "2.3× slower than …" rather than the cryptic "0.4× vs …"
        return { ...engine, perf: perfLine(headline) };
      }),
    },
  };
});

/** What the grid says while it has no cards to show — or none to come. */
const gridNote = (status) => (status === 'error'
  ? callout('Engine list unavailable',
    'The site content could not be loaded. The build collects it from the site document each workspace commits.')
  : callout('Loading…', 'Fetching the engines, as each package describes its own.'));

/**
 * The hero's first bullet is the conformance claim, and it becomes the
 * measured score once the run lands: the page used to claim a round
 * 100% the honest count does not support. A headline carrying no
 * pass/total pair leaves the authored, figure-free line standing.
 */
function heroWith(hero, headline) {
  const score = headline?.conformance;
  if (typeof score !== 'string' || !SCORE.test(score)) return hero;
  const [pass, total] = score.split(' / ');
  return {
    ...hero,
    points: [
      `${pass} of ${total} official JSON-Schema-Test-Suite tests pass, across every benchmarked draft`,
      ...hero.points.slice(1),
    ],
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
      state.site.data.packages, state.site.status.packages,
      state.bench.validate, state.benchStatus.validate,
      state.site.data.contract, state.site.status.contract,
      state.site.data.content);
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

/**
 * The docs page's sections, in reading order: the site's own preamble,
 * then one section per package that has committed a documentation body,
 * in census order, then the site-owned sections that close the page.
 *
 * A package section is markdown — the workspace wrote it beside its
 * code — so it renders through the site's ONE md component, the same
 * renderer the README dialog uses, and arrives here as a single article
 * node. Nothing about a package is authored inside the website package.
 * @param {any} content - The collected site content, or undefined.
 * @returns {any[]}
 */
export const docsSections = memo1((content) => {
  const owned = (content?.packages ?? [])
    .filter((/** @type {any} */ entry) => entry.docs !== null)
    .map((/** @type {any} */ entry) => ({
      id: entry.name.replace(/^@jarenjs\//, ''),
      title: entry.card.title,
      blocks: [article(mdArticle(md.view(entry.docs)))],
    }));
  if (owned.length === 0) return DOCS_SECTIONS;
  return [
    ...DOCS_SECTIONS.filter((s) => s.tail !== true),
    ...owned,
    ...DOCS_SECTIONS.filter((s) => s.tail === true),
  ];
});

const docsPage = memo1((param, census, status, validateRun, validateStatus,
  contractInfo, contractStatus, content) => {
  const all = docsSections(content);
  const current = param ?? all[0].id;
  const section = all.find((s) => s.id === current) ?? all[0];
  return {
    sections: all.map((s) => ({
      id: s.id,
      title: s.title,
      active: s.id === section.id,
      href: `#/docs?s=${s.id}`,
    })),
    section: {
      title: section.title,
      // a marker block is replaced by nodes derived from something the
      // repository measured or the site itself runs on; `flatMap`
      // because such a block can expand into a whole subsection
      blocks: section.blocks.flatMap((b) => {
        if (b.kind === 'measured') return measuredBlock(validateRun, validateStatus);
        if (b.kind === 'site-contract') return siteContractNodes(contractInfo, contractStatus);
        return b;
      }),
    },
    ...readmeRail(census, status, content),
  };
});

/**
 * A docs block declared `measured` is filled from the generated
 * benchmark run instead of being authored: the draft-support section
 * shows the official-suite scorecard through the SAME builder the
 * benchmarks page uses, so the two pages cannot print two scores for
 * one run. Until the run lands the section says what it is waiting for.
 * @param {any} run - The generated validate suite, or undefined.
 * @param {string | undefined} status
 */
function measuredBlock(run, status) {
  if (run === undefined) {
    return status === 'error'
      ? callout('Measured results unavailable',
        'The JSON Schema benchmark data could not be loaded. Generate it with: npm run benchmark:generate')
      : callout('Loading…', 'Fetching the measured official-suite results.');
  }
  return draftConformanceTable(run.summary?.engineStats);
}

/**
 * The README rail: one button per PUBLISHED workspace, from the census
 * the build derives from the workspace manifests. The site keeps no list
 * of its own, because a hand-kept copy drifts from the repository it
 * describes — so until the census lands the rail says what it is waiting
 * for, exactly as the benchmarks page does with its data.
 *
 * A package that has written its own site document describes itself in
 * that document's card; one that has not is described by its manifest,
 * which is where the collector's fallback card comes from. Either way
 * the rail shows the package's own words, never the website's.
 * @param {any} census - The generated census, or undefined.
 * @param {string | undefined} status
 * @param {any} content - The collected site content, or undefined.
 */
function readmeRail(census, status, content) {
  if (census === undefined) {
    return {
      packages: [],
      note: status === 'error'
        ? callout('Package list unavailable',
          'The package census could not be loaded. The site build generates it from the workspace manifests.')
        : callout('Loading…', 'Fetching the package census.'),
    };
  }
  const cards = new Map((content?.packages ?? [])
    .map((/** @type {any} */ entry) => [entry.name, entry.card]));
  return {
    packages: census.packages.map((entry) => ({
      name: entry.name,
      blurb: cards.get(entry.name)?.blurb ?? entry.description,
      url: readmeUrl(entry.dir),
    })),
  };
}
