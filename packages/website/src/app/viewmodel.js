//@ts-check
/**
 * The derivation boundary (APP-FORMAT §5.2): state in, the view
 * stylesheet's input document out, once per render. Only the ACTIVE
 * page's node exists under `$.ui` — the shell `$apply`s every page
 * member and absent members select nothing, so page switching needs no
 * conditionals in the stylesheet.
 */

import { deriveSuite, draftConformanceTable, SUITES } from '../boundaries/bench.js';
import { formViewFor, formLabelsFor, referencedSchemas, catalogFor } from '../boundaries/validator.js';
import { SITE_LANGUAGES } from '../boundaries/lang.js';
import { siteText, sitePackOf } from '../messages.js';
import { HOME_CONTENT } from '../content/home.js';
import { HERO_DEMO } from '../content/hero.js';
import { DOCS_SECTIONS } from '../content/docs.js';
import { md, mdArticle, mdLabels, rewriteReadmeLinks, readmeUrl, TRUSTED } from '../boundaries/markdown.js';
import { chartsPageDemos, chartsPageSampling, chartsPageStreamingCallout } from '../boundaries/chartspage.js';
import { binanceInvitation } from '../boundaries/binance.js';
import { contributeCalcViewModel } from '@jarenjs/calc/component';

import { flowPageViewModel } from '../boundaries/flowstudio.js';
import { projectComponent } from '../boundaries/project.js';
import { PROJECT_TEMPLATE_CARDS } from '../content/projectTemplates.js';
import { playComponent, withPlayLocale } from '../boundaries/play.js';

import { dataViewModel } from '../boundaries/data.js';
import { siteContractNodes } from '../boundaries/site.js';
import { formatRatio, memo1 } from '../lib/format.js';
import { article, callout } from '../lib/nodes.js';

// the nav is grouped into three dropdown menus by what each surface IS:
// stateless ENGINES you tinker with, stateful STUDIOS you compose in, and
// LEARN (the read/measure pages). Home stands alone before the groups.
// The labels are the site's own words (`site/nav/*`, in the reader's language).
const HOME_LINK = { page: 'home', label: 'site/nav/home', href: '#/' };
const NAV_GROUPS = [
  { key: 'engines', label: 'site/nav/engines', pages: [
    { page: 'play', label: 'site/nav/play', href: '#/play' },
    { page: 'charts', label: 'site/nav/charts', href: '#/charts' },
    { page: 'collection', label: 'site/nav/collections', href: '#/collection' },
  ] },
  { key: 'studios', label: 'site/nav/studios', pages: [
    { page: 'project', label: 'site/nav/studio', href: '#/project' },
    { page: 'flow', label: 'site/nav/flow', href: '#/flow' },
    { page: 'data', label: 'site/nav/data', href: '#/data' },
    { page: 'calculator', label: 'site/nav/calculator', href: '#/calculator' },
  ] },
  { key: 'learn', label: 'site/nav/learn', pages: [
    { page: 'docs', label: 'site/nav/docs', href: '#/docs' },
    { page: 'benchmarks', label: 'site/nav/benchmarks', href: '#/benchmarks' },
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
 * @param {any} content - The collected cards, or undefined. This page
 *   shows no documentation body, so it reads the artifact that carries
 *   none: the same entries, an order of magnitude fewer bytes.
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
const homeContent = (state, say) => withDispatch(
  composeHome(engineCards(state.site.data.cards),
    state.bench?.meta?.headlines, state.site.status.cards, say),
  heroDemo(state.hero));

/** The home page with its words (the hero's dispatch carries them too, so
 * its rule reads them from its own node), kept by reference while neither
 * changes: a rule that read the document root would re-render on every
 * unrelated change. */
const homeUi = memo1((home, w) => ({ ...home, w, dispatch: home.dispatch == null ? home.dispatch : { ...home.dispatch, w } }));

/** The home page's clickable words (its prose stays English by design). @param {any} say */
const homeWords = memo1((say) => ({
  openPlay: say('site/home/open-play'), seeBenchmarks: say('site/home/see-benchmarks'),
  openStudio: say('site/home/open-studio'), breakIt: say('site/home/break-it'), dispatchInput: say('site/home/dispatch-input'),
}));

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

const composeHome = memo1((engines, headlines, status, say) => {
  // the grid is fetched, so the page renders before it exists: say what
  // it is waiting for, exactly as the docs rail does with its census —
  // an empty grid under "One stack, 0 engines" would be a lie told for
  // one frame
  if (engines.length === 0) return { ...HOME_CONTENT, enginesNote: gridNote(status, say) };
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
const gridNote = (status, say) => (status === 'error'
  ? callout(say('site/home/engines-unavailable'),
    'The site content could not be loaded. The build collects it from the site document each workspace commits.')
  : callout('Loading…', 'Fetching the engines, as each package describes its own.'));

/**
 * The hero's first bullet is the conformance claim, and it becomes the
 * measured score once the run lands: a round 100% would claim more than
 * the honest count supports. A headline carrying no pass/total pair
 * leaves the authored, figure-free line standing.
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
 * The header's language switch: every language the site offers, named in
 * its own language, the current one selected, its label in the site's words.
 * @param {any} state
 */
function languageSwitch(state) {
  const current = state.lang ?? 'en';
  return {
    label: siteText(sitePackOf(state))('site/lang/label'),
    choices: SITE_LANGUAGES.map(({ code, name, dir }) => ({ value: code, label: name, lang: code, dir, selected: code === current })),
  };
}

/**
 * @param {any} state
 * @returns {any} the view input document
 */
export function viewModel(state) {
  const page = state.route.page;
  /** @type {any} */
  const say = wordsOf(sitePackOf(state));
  const ui = { nav: deriveNav(page, state.navOpen, say), lang: languageSwitch(state), shell: shellWords(say) };

  if (page === 'home') ui.home = homeUi(homeContent(state, say), homeWords(say));
  if (page === 'benchmarks') ui.bench = benchPage(state);
  if (page === 'charts') ui.chartsPage = chartsPage(state);
  if (page === 'collection') {
    const mode = state.route.params.mode ?? 'array';
    const pack = sitePackOf(state);
    // keyed by the site pack's arrival too: a widget mounted while the
    // language's words were still loading remounts once they land
    ui.collection = { mode, key: `${mode}:${state.lang ?? 'en'}${pack === null ? '' : '+site'}`,
      title: wordsOf(pack)('site/collection/title') };
  }
  if (page === 'project') {
    // the shell speaks the site language: a language whose pack is still
    // loading has no catalog yet, and renders English
    ui.project = { ...projectComponent.viewModel({ project: state.project }, { messages: catalogFor(state.lang) }),
      templates: PROJECT_TEMPLATE_CARDS };
    // the site's save/share bar (the IDE store) renders above the IDE shell
    ui.projectIde = ideModel(state.ide.name, state.ide.names, state.ide.shared, ideWords(sitePackOf(state)));
  }
  if (page === 'play') {
    // the panes read the site language, as the run does
    const play = withPlayLocale(state.play, state.lang);
    // a language whose pack is still loading has no catalog yet: English, never ids
    ui.play = playComponent.viewModel({ play }, { messages: catalogFor(state.lang) });
    // the validate engine's data pane can toggle to a schema-generated form;
    // the form tree is built here (it needs @jarenjs/forms, a host dep) from
    // the schema source + the structured buffer, and mounted at `dataForm`;
    // its chrome speaks the language of its alerts (read at `formLabels`)
    if (play.engine === 'validate' && play.dataView === 'form') {
      ui.play.dataForm = formViewFor(play.source?.schema ?? '', play.dataValue, referencedSchemas(play.source?.schemas),
        play.config?.locale);
      ui.play.formLabels = formLabelsFor(play.config?.locale);
    }
  }
  if (page === 'flow') ui.flow = { ...flowPageViewModel(state.flow, catalogFor(state.lang)), title: siteText(sitePackOf(state))('site/flow/title') };
  if (page === 'data') ui.data = { ...dataViewModel(state, catalogFor(state.lang)), title: siteText(sitePackOf(state))('site/data/title') };
  if (page === 'docs') {
    ui.docs = docsPage(state.route.params.s,
      state.site.data.packages, state.site.status.packages,
      state.bench.validate, state.benchStatus.validate,
      state.site.data.contract, state.site.status.contract,
      state.site.data.content, wordsOf(sitePackOf(state)), catalogFor(state.lang));
  }
  if (page === 'calculator') ui.calculator = contributeCalcViewModel(state, { theme: 'host', messages: catalogFor(state.lang) });

  // The README dialog is a global overlay (any page can open it): it
  // only materializes when open, so the shell's $apply renders nothing
  // otherwise. `md.view` memoizes the article by source string, so a
  // re-render with the same README returns the same vnode reference.
  if (state.readme.open) ui.readme = readmeOverlay(state.readme, wordsOf(sitePackOf(state)), catalogFor(state.lang));

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

/** The README dialog's overlay model, memoized on the readme slice and the site's words. */
const readmeOverlay = memo1((readme, say, catalog) => ({
  w: readmeWords(say),
  title: readme.title,
  status: readme.status,
  message: readme.message,
  canBack: readme.at > 0,
  canForward: readme.at < readme.stack.length - 1,
  // repo-relative links inside the article navigate the dialog itself
  article: readme.source !== null
    ? rewriteReadmeLinks(md.view(readme.source, { ...TRUSTED, ...mdLabels(catalog) }), readme.url)
    : null,
}));

/** The nav model: a standalone Home link + three dropdown groups, each with
 * an `open` flag (from state.navOpen) and an `active` flag (the current page
 * lives in it). Cheap, so not memoized — it must recompute when navOpen
 * changes, which a page-only memo key would miss. */
function deriveNav(page, navOpen, say) {
  return {
    home: { ...HOME_LINK, label: say(HOME_LINK.label), active: page === 'home' },
    groups: NAV_GROUPS.map((g) => ({
      key: g.key,
      label: say(g.label),
      open: navOpen === g.key,
      active: g.pages.some((p) => p.page === page),
      items: g.pages.map((p) => ({ ...p, label: say(p.label), active: p.page === page })),
    })),
  };
}

/** The header's own controls: the theme and menu toggles' names. @param {any} say */
const shellWords = memo1((say) => ({
  theme: say('site/shell/theme'), menu: say('site/shell/menu'), navToggle: say('site/shell/nav-toggle'),
}));

/**
 * The site's words in one language, compiled once per site pack (null
 * for English): every page below reads its labels through this.
 * @type {(pack: Readonly<Record<string, string>> | null) => (id: any, params?: Record<string, unknown>) => string}
 */
const wordsOf = memo1((pack) => siteText(pack));

/** The README dialog's controls, once per language. */
const readmeWords = memo1((say) => ({
  back: say('site/readme/back'), forward: say('site/readme/forward'), close: say('site/readme/close'),
  loading: say('site/readme/loading'), error: say('site/readme/error'),
}));

/** A suite tab's label, where the suite's name is a word rather than a product. */
const SUITE_LABELS = {
  overview: 'site/bench/suite/overview',
  contracts: 'site/bench/suite/contracts',
  contract: 'site/bench/suite/contract',
  formats: 'site/bench/suite/formats',
  view: 'site/bench/suite/view',
  charts: 'site/bench/suite/charts',
  geo: 'site/bench/suite/geo',
  flow: 'site/bench/suite/flow',
  db: 'site/bench/suite/db',
  spatial: 'site/bench/suite/spatial',
  live: 'site/bench/suite/live',
  vector: 'site/bench/suite/vector',
  series: 'site/bench/suite/series',
};

const benchTabs = memo1((suite, say) => SUITES.map((s) => ({
  ...s,
  label: Object.hasOwn(SUITE_LABELS, s.key) ? say(/** @type {any} */ (SUITE_LABELS)[s.key]) : s.label,
  active: s.key === suite,
  href: `#/benchmarks?suite=${s.key}`,
})));

// keyed on the slices deriveSuite actually reads — never the state
// root, which is fresh every transition and would defeat the memo
const benchNodes = memo1((suite, data, status, benchUi, unknown, say) => {
  const need = suite === 'overview' ? 'meta' : suite;
  const nodes = deriveSuite({ bench: { [need]: data }, benchStatus: { [need]: status }, benchUi }, suite, say);
  return unknown === null ? nodes : [
    callout(say('site/bench/no-such-suite'), `There is no benchmark suite named '${unknown}' — showing the overview instead.`),
    ...nodes,
  ];
});

const composeBench = memo1((suites, nodes, say) => ({ w: benchWords(say), suites, nodes }));

/** The benchmarks page's own words, once per language. */
const benchWords = memo1((say) => ({ title: say('site/bench/title') }));

const chartsPage = (state) => composeChartsPage(state.chartsLive, wordsOf(sitePackOf(state)));
// a live feed paints in the words it was started in (boundaries/binance.js)
const composeChartsPage = memo1((live, say) => ({
  w: { title: say('site/charts/title'), live: say('site/charts/live'), demos: say('site/charts/demos') },
  live: live ?? binanceInvitation(say),
  demos: [...chartsPageDemos(say), ...chartsPageSampling(say), chartsPageStreamingCallout(say)],
}));

function benchPage(state) {
  // an unknown ?suite= shows the overview plus an honest callout (the
  // route/set gate never fetched for it, so nothing is loading either)
  const requested = state.route.params.suite ?? 'overview';
  const known = SUITES.some((s) => s.key === requested);
  const suite = known ? requested : 'overview';
  const need = suite === 'overview' ? 'meta' : suite;
  const say = wordsOf(sitePackOf(state));
  return composeBench(
    benchTabs(suite, say),
    benchNodes(suite, state.bench[need], state.benchStatus[need], state.benchUi,
      known ? null : requested, say),
    say);
}

/** The Project IDE-bar model (name field, share status, saved chips). */
const ideModel = memo1((name, names, shared, w) => ({
  name,
  shared,
  w,
  // a saved-name chip is its own rule, matched at its own node: it carries its words
  names: names.map((n) => ({ name: n, w })),
}));

/** The IDE bar's words in the site language, once per site pack. */
const ideWords = memo1((pack) => {
  const t = siteText(pack);
  return {
    namePlaceholder: t('site/ide/name-placeholder'), save: t('site/ide/save'), share: t('site/ide/share'),
    shareTitle: t('site/ide/share-title'), download: t('site/ide/download'), downloadTitle: t('site/ide/download-title'),
    appJson: t('site/ide/app-json'), appJsonTitle: t('site/ide/app-json-title'), offlineZip: t('site/ide/offline-zip'),
    loadTitle: t('site/ide/load-title'), deleteTitle: t('site/ide/delete-title'),
  };
});

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
export const docsSections = memo1((content, catalog = undefined) => {
  const owned = (content?.packages ?? [])
    .filter((/** @type {any} */ entry) => entry.docs !== null)
    .map((/** @type {any} */ entry) => ({
      id: entry.name.replace(/^@jarenjs\//, ''),
      title: entry.card.title,
      // md's own accessible names (permalinks, footnotes) in the reader's language
      blocks: [article(mdArticle(md.view(entry.docs, { ...TRUSTED, ...mdLabels(catalog) })))],
    }));
  if (owned.length === 0) return DOCS_SECTIONS;
  return [
    ...DOCS_SECTIONS.filter((s) => s.tail !== true),
    ...owned,
    ...DOCS_SECTIONS.filter((s) => s.tail === true),
  ];
});

const docsPage = memo1((param, census, status, validateRun, validateStatus,
  contractInfo, contractStatus, content, say, catalog) => {
  const all = docsSections(content, catalog);
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
        if (b.kind === 'measured') return measuredBlock(validateRun, validateStatus, say);
        if (b.kind === 'site-contract') return siteContractNodes(contractInfo, contractStatus, say);
        return b;
      }),
    },
    ...readmeRail(census, status, content, say),
    w: docsWords(say),
  };
});

/** The docs page's own words, once per language. */
const docsWords = memo1((say) => ({
  title: say('site/docs/title'),
  readmes: say('site/docs/readmes'),
  readmesNote: say('site/docs/readmes-note'),
}));

/**
 * A docs block declared `measured` is filled from the generated
 * benchmark run instead of being authored: the draft-support section
 * shows the official-suite scorecard through the SAME builder the
 * benchmarks page uses, so the two pages cannot print two scores for
 * one run. Until the run lands the section says what it is waiting for.
 * @param {any} run - The generated validate suite, or undefined.
 * @param {string | undefined} status
 */
function measuredBlock(run, status, say) {
  if (run === undefined) {
    return status === 'error'
      ? callout(say('site/conformance/unavailable'),
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
 * @param {(id: any, params?: Record<string, unknown>) => string} say - the site's words
 */
function readmeRail(census, status, content, say) {
  if (census === undefined) {
    return {
      packages: [],
      note: status === 'error'
        ? callout(say('site/docs/rail-unavailable'),
          'The package census could not be loaded. The site build generates it from the workspace manifests.')
        : callout(say('site/docs/rail-loading'), say('site/docs/rail-loading-text')),
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
