//@ts-check
/**
 * The Play boundary — the site's glue for `@jarenjs/play`. The engine
 * playground: pick an engine + an example, edit the source or the data, and
 * it runs live — the registered operator packs threaded in so `$mean`/`$npv`
 * work in the query/jslt engines. Ephemeral (no document, unlike the studio).
 * The slice, its language rules and the session file are
 * `@jarenjs/play/host`'s; this module keeps the site's wiring: the visual
 * renderers, the site's words, the retired playground's links.
 */
import { createSplitterWidget } from '@jarenjs/app';
import { createPlayComponent } from '@jarenjs/play/component';
import { runPlay as runPlayHosted } from '@jarenjs/play/host';
import { toMarkdown } from '@jarenjs/md';
import { createMdx } from '@jarenjs/md/mdx';
import { compileJsonQuery } from '@jarenjs/json';
import { operatorRegistry } from './engines.js';
import { md, mdArticle, mdLabels, UNTRUSTED } from './markdown.js';
import { mermaidFor } from './mermaid.js';
import { mermaidErrorText } from '@jarenjs/mermaid';
import { chartRenderer } from './charts.js';
import { validateLocalized, catalogFor } from './validator.js';
import { siteText } from '../messages.js';
import { formatJson, timed } from '../lib/format.js';

/** The component, with the site's math/finance/stats packs mounted. */
export const playComponent = createPlayComponent({ operators: operatorRegistry });

/** The mdx pass (markdown × data), with the suite's own query compiler
 * injected — the expression language IS jaren-query, no new mini-language. */
const mdx = createMdx({ compileQuery: compileJsonQuery });

/**
 * Host-injected vnode renderers for the playground's VISUAL engines (the
 * hybrid seam): @jarenjs/play owns the markdown/mermaid/charts descriptors
 * + examples, but stays free of those component deps — the rendering happens
 * here, reusing the site's own memoized md/mermaid components and the charts
 * static path. `md.view` / `mermaid.view` are memoized per source string.
 *
 * Markdown and Mermaid also hand back `deep` panels — the drill-down
 * explainers only the host can derive (the JSON AST, the canonical
 * round-trip): teacher-voiced, revealed behind the depth toggle.
 *
 * Each renderer also reports its own `compileMs` / `runMs`. Play cannot
 * split a host render from the outside — it would only have one wall-clock
 * number for both phases — and these renderers genuinely have two: the
 * source compiles to a document, then the document builds a vnode. Report
 * them and the stage prints two real numbers; omit them and it honestly
 * prints one.
 */

/**
 * The renderers in one language: their deep panels' names are the site's
 * words, the rest of what they draw is the engines'.
 * @param {(id: any, params?: Record<string, unknown>) => string} say
 */
const renderersWith = (say) => ({
  markdown: (source, _config, ctx) => {
    const compiled = timed(() => md.compile(source).doc);
    const doc = compiled.value;
    const rendered = timed(() => mdArticle(md.view(source, { ...UNTRUSTED, ...mdLabels(ctx?.messages) })));
    return {
      compileMs: compiled.ms,
      runMs: rendered.ms,
      vnode: rendered.value,
      deep: [
        { id: 'ast', label: say('site/play/panel/document-json'), kind: 'code', text: formatJson(doc.ast) },
        { id: 'roundtrip', label: say('site/play/panel/canonical-markdown'), kind: 'code', text: toMarkdown(doc) },
        ...(doc.frontmatter !== null
          ? [{ id: 'frontmatter', label: say('site/play/panel/frontmatter'), kind: 'code', text: formatJson(doc.frontmatter) }]
          : []),
      ],
    };
  },
  // mdx receives the PARSED data document as its second argument: the pass
  // resolves the template against it, then renders through the same
  // memoized md pipeline (the doc-keyed memo carries the transformed doc)
  mdx: (source, dataValue, ctx) => {
    const compiled = timed(() => mdx.transform(md.compile(source).doc, dataValue));
    const doc = compiled.value;
    const rendered = timed(() => mdArticle(md.view(doc, { ...UNTRUSTED, ...mdLabels(ctx?.messages) })));
    return {
      compileMs: compiled.ms,
      runMs: rendered.ms,
      vnode: rendered.value,
      deep: [
        { id: 'rendered', label: say('site/play/panel/resolved-markdown'), kind: 'code', text: toMarkdown(doc) },
        { id: 'ast', label: say('site/play/panel/document-json'), kind: 'code', text: formatJson(doc.ast) },
      ],
    };
  },
  mermaid: (source, _config, ctx) => {
    // the diagram's own words (its error card, an accessible name) in the
    // reader's language
    const component = mermaidFor(ctx?.messages);
    const step = timed(() => component.compile(source));
    const compiled = step.value;
    const doc = compiled.doc;
    const rendered = timed(() => component.view(source));
    return {
      compileMs: step.ms,
      runMs: rendered.ms,
      vnode: rendered.value,
      deep: [
        { id: 'ast', label: say('site/play/panel/mermaid-ast'), kind: 'code',
          text: doc ? formatJson(doc.ast) : compiled.parseError ? mermaidErrorText(compiled.parseError, ctx?.messages) : 'parse error' },
        { id: 'roundtrip', label: say('site/play/panel/canonical-mermaid'), kind: 'code', text: compiled.toText() },
      ],
    };
  },
  charts: (source, config, ctx) => chartRenderer(source, config, ctx),
});

/** English, and once per site pack. @type {Map<object | null, ReturnType<typeof renderersWith>>} */
const RENDERERS_BY_PACK = new Map();
/** @param {Readonly<Record<string, string>> | null} sitePack */
const renderersFor = (sitePack) => {
  let made = RENDERERS_BY_PACK.get(sitePack);
  if (made === undefined) {
    made = renderersWith(siteText(sitePack));
    RENDERERS_BY_PACK.set(sitePack, made);
  }
  return made;
};

/** The slice, the reader-language rules and the session file: the kit's. */
export {
  PLAY_START, withPlayLocale, loadExample, loadDataset, deepLinkExample, switchPlayOption,
  sessionOf, sessionToLoaded, sessionDocument, sessionFromDocument, sessionFilename, blankSession,
} from '@jarenjs/play/host';

/**
 * A LEGACY playground snapshot → a play session, so links and saved
 * experiments from the retired `#/playground` keep working. The legacy
 * shape is `(engine, inputs)` with flat text inputs; `validate` carried
 * `{ schemaText, data }` (the data as a VALUE). Inputs are split into
 * play's source / data / config panes by the engine descriptor; a key
 * with no play home (the old pointer/patch mode sub-fields) is dropped.
 * @param {string} engine
 * @param {any} inputs
 * @returns {any | null} a `play/loaded-session`-shaped session, or null
 */
export function legacyExperimentToSession(engine, inputs) {
  const given = inputs && typeof inputs === 'object' ? inputs : {};
  if (engine === 'validate') {
    return {
      engine: 'validate', exampleId: null,
      source: { schema: typeof given.schemaText === 'string' ? given.schemaText : '' },
      data: { data: JSON.stringify(given.data ?? null, null, 2) },
      config: {},
    };
  }
  // an own engine only: a name every object inherits (`constructor`) is not one
  if (!Object.hasOwn(playComponent.engines, engine)) return null;
  const descriptor = playComponent.engines[engine];
  /** @type {Record<string, string>} */
  const source = {};
  /** @type {Record<string, string>} */
  const data = {};
  /** @type {Record<string, string>} */
  const config = {};
  for (const [key, value] of Object.entries(given)) {
    if (typeof value !== 'string') continue;
    if (descriptor.sourcePanes.some((p) => p.key === key)) source[key] = value;
    else if (descriptor.dataPanes.some((p) => p.key === key)) data[key] = value;
    else if ((descriptor.optionPanes ?? []).some((p) => p.key === key)) config[key] = value;
  }
  return { engine, exampleId: null, source, data, config };
}

/** The Play IDE's editor|result splitter (`play-splitter`): the shared
 * `@jarenjs/app` widget bound to the play grid — drives `--jplay-ratio` live
 * during a drag and commits `play/layout-ratio` on pointer-up. */
export function createPlaySplitterWidget() {
  return createSplitterWidget({
    grid: '.jplay', rail: '.jplay-rail', cssVar: '--jplay-ratio', action: 'play/layout-ratio',
  });
}

/** Host-injected JSON Schema validator for the `validate` engine (the hybrid
 * seam): the site's cached runner, its errors localized to the chosen locale
 * — so @jarenjs/validate + the locale packs stay in the host. A schema text
 * that is not JSON is refused in the site's words.
 * @param {string} schemaText @param {any} data @param {string} locale @param {any[]} schemas
 * @param {Readonly<Record<string, string>> | null} [sitePack] - the site's words in the reader's language
 */
function validateRunner(schemaText, data, locale, schemas, sitePack = null) {
  const report = validateLocalized(schemaText, data, locale, schemas);
  if (report.schemaJsonReason === undefined) return report;
  return { ...report, schemaError: siteText(sitePack)('site/schema/invalid-json', { reason: report.schemaJsonReason }) };
}

/**
 * Run the active engine over the current source + data (operators, option
 * config, visual renderers, the validator), in the site language: play's
 * words and every engine's messages through that language's pack.
 * @param {any} slice - the `state.play` slice
 * @param {string | null} [lang] - the site language, null for English
 * @param {Readonly<Record<string, string>> | null} [sitePack] - the site's words in that language
 */
export function runPlay(slice, lang = null, sitePack = null) {
  // a language whose pack has not landed yet has no catalog: English, never ids
  return runPlayHosted(playComponent, slice, {
    lang, catalogs: { catalogFor }, operators: operatorRegistry, renderers: renderersFor(sitePack),
    validate: (/** @type {string} */ schemaText, /** @type {any} */ data, /** @type {string} */ locale, /** @type {any[]} */ schemas) =>
      validateRunner(schemaText, data, locale, schemas, sitePack),
  });
}
