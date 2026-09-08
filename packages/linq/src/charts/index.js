//@ts-check
/** Chart-definition factories; the chart engine is injected by the consumer. */
import { DocumentBuilder, optionsOf } from '../authored.js';
import { LinqBuildError } from '../errors.js';
import { CHART_FIELDS } from './vocabulary.js';

/** Immutable chart definition; methods keep the original discriminator. */
export class ChartBuilder extends DocumentBuilder {
  /** @param {Record<string, any>} value */
  options(value) {
    const keys = CHART_FIELDS[this.schema.type];
    if (keys === undefined) throw new LinqBuildError('JL0101', `unknown chart kind '${this.schema.type}'`);
    return this.with(optionsOf(value, keys, `${this.schema.type}()`));
  }
  /** `title`. @param {any} value */
  title(value) { return this.options({ title: value }); }
  /** `stream`. @param {any} value */
  stream(value) { return this.options({ stream: value }); }
  /** `donut`. @param {any} value */
  donut(value) { return this.options({ donut: value }); }
  /** `slices`. @param {any} value */
  slices(value) { return this.options({ slices: value }); }
  /** `stacked`. @param {any} value */
  stacked(value) { return this.options({ stacked: value }); }
  /** `log`. @param {any} value */
  log(value) { return this.options({ log: value }); }
  /** `orient`. @param {any} value */
  orient(value) { return this.options({ orient: value }); }
  /** `catLabel`. @param {any} value */
  catLabel(value) { return this.options({ catLabel: value }); }
  /** `valLabel`. @param {any} value */
  valLabel(value) { return this.options({ valLabel: value }); }
  /** `categories`. @param {any} value */
  categories(value) { return this.options({ categories: value }); }
  /** `series`. @param {any} value */
  series(value) { return this.options({ series: value }); }
  /** `x`. @param {any} value */
  x(value) { return this.options({ x: value }); }
  /** `markers`. @param {any} value */
  markers(value) { return this.options({ markers: value }); }
  /** `xLabel`. @param {any} value */
  xLabel(value) { return this.options({ xLabel: value }); }
  /** `yLabel`. @param {any} value */
  yLabel(value) { return this.options({ yLabel: value }); }
  /** `domain`. @param {any} value */
  domain(value) { return this.options({ domain: value }); }
  /** `sampling`. @param {any} value */
  sampling(value) { return this.options({ sampling: value }); }
  /** `dateNames`. @param {any} value */
  dateNames(value) { return this.options({ dateNames: value }); }
  /** `timeFormats`. @param {any} value */
  timeFormats(value) { return this.options({ timeFormats: value }); }
  /** `candles`. @param {any} value */
  candles(value) { return this.options({ candles: value }); }
  /** `xLog`. @param {any} value */
  xLog(value) { return this.options({ xLog: value }); }
  /** `yLog`. @param {any} value */
  yLog(value) { return this.options({ yLog: value }); }
  /** `refY`. @param {any} value */
  refY(value) { return this.options({ refY: value }); }
  /** `refLabel`. @param {any} value */
  refLabel(value) { return this.options({ refLabel: value }); }
  /** `points`. @param {any} value */
  points(value) { return this.options({ points: value }); }
  /** `max`. @param {any} value */
  max(value) { return this.options({ max: value }); }
  /** `axes`. @param {any} value */
  axes(value) { return this.options({ axes: value }); }
  /** `value`. @param {any} value */
  value(value) { return this.options({ value: value }); }
  /** `min`. @param {any} value */
  min(value) { return this.options({ min: value }); }
  /** `unit`. @param {any} value */
  unit(value) { return this.options({ unit: value }); }
  /** `tone`. @param {any} value */
  tone(value) { return this.options({ tone: value }); }
  /** `boxes`. @param {any} value */
  boxes(value) { return this.options({ boxes: value }); }
  /** `xLabels`. @param {any} value */
  xLabels(value) { return this.options({ xLabels: value }); }
  /** `yLabels`. @param {any} value */
  yLabels(value) { return this.options({ yLabels: value }); }
  /** `values`. @param {any} value */
  values(value) { return this.options({ values: value }); }
  /** `aspect`. @param {any} value */
  aspect(value) { return this.options({ aspect: value }); }
  /** `items`. @param {any} value */
  items(value) { return this.options({ items: value }); }
  /** `xs`. @param {any} value */
  xs(value) { return this.options({ xs: value }); }
  /** `nodes`. @param {any} value */
  nodes(value) { return this.options({ nodes: value }); }
  /** `links`. @param {any} value */
  links(value) { return this.options({ links: value }); }
  /** `label`. @param {any} value */
  label(value) { return this.options({ label: value }); }
  /** `simplify`. @param {any} value */
  simplify(value) { return this.options({ simplify: value }); }
  /** `features`. @param {any} value */
  features(value) { return this.options({ features: value }); }
}

/** A raw public chart definition, including JSON extensions. @param {any} document */
export function from(document) { return new ChartBuilder(document); }

/** A pie chart. @param {object} [options] */
export function pie(options = {}) { return new ChartBuilder({ type: 'pie' }).options(options); }
/** A bar chart. @param {object} [options] */
export function bar(options = {}) { return new ChartBuilder({ type: 'bar' }).options(options); }
/** A line chart. @param {object} [options] */
export function line(options = {}) { return new ChartBuilder({ type: 'line' }).options(options); }
/** A scatter chart. @param {object} [options] */
export function scatter(options = {}) { return new ChartBuilder({ type: 'scatter' }).options(options); }
/** A candlestick chart. @param {object} [options] */
export function candlestick(options = {}) { return new ChartBuilder({ type: 'candlestick' }).options(options); }
/** A radar chart. @param {object} [options] */
export function radar(options = {}) { return new ChartBuilder({ type: 'radar' }).options(options); }
/** A gauge chart. @param {object} [options] */
export function gauge(options = {}) { return new ChartBuilder({ type: 'gauge' }).options(options); }
/** A boxplot chart. @param {object} [options] */
export function boxplot(options = {}) { return new ChartBuilder({ type: 'boxplot' }).options(options); }
/** A heatmap chart. @param {object} [options] */
export function heatmap(options = {}) { return new ChartBuilder({ type: 'heatmap' }).options(options); }
/** A treemap chart. @param {object} [options] */
export function treemap(options = {}) { return new ChartBuilder({ type: 'treemap' }).options(options); }
/** A streamgraph chart. @param {object} [options] */
export function streamgraph(options = {}) { return new ChartBuilder({ type: 'streamgraph' }).options(options); }
/** A sankey chart. @param {object} [options] */
export function sankey(options = {}) { return new ChartBuilder({ type: 'sankey' }).options(options); }
/** A map chart. @param {object} [options] */
export function map(options = {}) { return new ChartBuilder({ type: 'map' }).options(options); }
