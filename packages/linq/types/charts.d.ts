// Derived from chart-definition.schema.json by scripts/generate-chart-pen.js.
/**
 * createStreamAdapter mapping: how reader events accumulate into this chart's data
 */
export interface StreamSpec {
  recordPath?: Array<string | number>;
  recordBoundary?: "path" | "document";
  xField?: string;
  yField?: string;
  seriesField?: string;
  /**
   * Schema constraints this type cannot express: type="integer", minimum=1
   */
  maxPoints?: number;
  [key: string]: unknown;
}


export interface Slice {
  label: string;
  /**
   * Schema constraints this type cannot express: minimum=0
   */
  value: number;
  [key: string]: unknown;
}


export type Tone = "win" | "loss" | null;

export interface BarSeries {
  name: string;
  values: Array<number | null>;
  tone?: Tone;
  tones?: Array<Tone>;
  [key: string]: unknown;
}


export interface Point {
  x: number;
  y: number;
  tone?: Tone;
  [key: string]: unknown;
}


export interface LineSeries {
  name: string;
  points: Array<Point>;
  [key: string]: unknown;
}


export interface Candle {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  [key: string]: unknown;
}


/**
 * a named series of index-aligned values (radar axes / streamgraph samples)
 */
export interface ValueSeries {
  name: string;
  values: Array<number | null>;
  [key: string]: unknown;
}


/**
 * one boxplot category: raw samples in `values`, or a precomputed five-number summary
 */
export type Box = ({ values: unknown; [key: string]: unknown; } | Array<unknown> | string | number | boolean | null | { min: unknown; q1: unknown; med: unknown; q3: unknown; max: unknown; [key: string]: unknown; }) & { label: string; values?: Array<number | null>; min?: number; q1?: number; med?: number; q3?: number; max?: number; outliers?: Array<number>; [key: string]: unknown; };

export interface TreemapItem {
  label: string;
  /**
   * Schema constraints this type cannot express: exclusiveMinimum=0
   */
  value: number;
  [key: string]: unknown;
}


/**
 * one hierarchy level: the group's value is its children's sum
 */
export interface TreemapGroup {
  label: string;
  /**
   * Schema constraints this type cannot express: minItems=1
   */
  children: Array<TreemapItem>;
  [key: string]: unknown;
}


/**
 * a flow from source to target; endpoints are node names or node indexes
 */
export interface SankeyLink {
  /**
   * Schema constraints this type cannot express: type="integer"
   */
  source: string | number;
  /**
   * Schema constraints this type cannot express: type="integer"
   */
  target: string | number;
  /**
   * Schema constraints this type cannot express: exclusiveMinimum=0
   */
  value: number;
  [key: string]: unknown;
}


/**
 * Schema constraints this type cannot express: minimum=-180, maximum=180
 */
export type MapPointAtItem1 = number;

/**
 * Schema constraints this type cannot express: minimum=-90, maximum=90
 */
export type MapPointAtItem2 = number;

/**
 * a place marker: the convenience path for a caller holding positions rather than GeoJSON
 */
export interface MapPoint {
  /**
   * a GeoJSON position: [longitude, latitude]
   * Schema constraints this type cannot express: minItems=2, maxItems=3
   */
  at: [MapPointAtItem1, MapPointAtItem2, ...Array<number>];
  label?: string;
  value?: number;
  [key: string]: unknown;
}


export interface SamplingPolicyAnyOf3 {
  method?: "lttb" | "minmax";
  /**
   * the most points one series may draw; an explicit target makes the rendered line independent of any layout
   * Schema constraints this type cannot express: type="integer", minimum=2
   */
  target?: number;
  /**
   * the width the derived target assumes, in CSS pixels (default 560)
   * Schema constraints this type cannot express: exclusiveMinimum=0
   */
  width?: number;
  /**
   * Schema constraints this type cannot express: exclusiveMinimum=0
   */
  pixelRatio?: number;
  [key: string]: unknown;
}


/**
 * how many of a line's points are drawn: false never samples, a method name or object samples whatever the count, and an omitted member samples a TIME line above 2000 points through @jarenjs/core/series. Distinct from stream.maxPoints, which decides what exists rather than what is drawn.
 */
export type SamplingPolicy = false | "lttb" | "minmax" | SamplingPolicyAnyOf3;

/**
 * the month, weekday and meridiem names a time-axis pattern with a name token reads (compileDateLocale(pack).names from @jarenjs/locales); a name token with no record is a compile error, never an English fallback
 */
export interface DateNames {
  /**
   * Schema constraints this type cannot express: minItems=12, maxItems=12
   */
  months?: Array<string>;
  /**
   * Schema constraints this type cannot express: minItems=12, maxItems=12
   */
  monthsShort?: Array<string>;
  /**
   * Schema constraints this type cannot express: minItems=7, maxItems=7
   */
  weekdays?: Array<string>;
  /**
   * Schema constraints this type cannot express: minItems=7, maxItems=7
   */
  weekdaysShort?: Array<string>;
  /**
   * Schema constraints this type cannot express: minItems=2, maxItems=2
   */
  meridiem?: Array<string>;
  [key: string]: unknown;
}


/**
 * LDML label patterns for a time axis, keyed by the granularity of the tick step; an omitted member keeps its numeric default (HH:mm:ss, HH:mm, yyyy-MM-dd, yyyy-MM, yyyy)
 */
export interface TimeFormats {
  second?: string;
  minute?: string;
  day?: string;
  month?: string;
  year?: string;
  [key: string]: unknown;
}


export interface DomainPolicyX {
  /**
   * Schema constraints this type cannot express: exclusiveMinimum=0
   */
  window: number;
  /**
   * Schema constraints this type cannot express: exclusiveMinimum=0
   */
  slide?: number;
  [key: string]: unknown;
}


/**
 * domain-stability policy: a quantized sliding x window and/or pinned or step-quantized y bounds, so most streaming ticks keep the scales still
 */
export interface DomainPolicy {
  x?: DomainPolicyX;
  y?: "step" | { min?: number; max?: number; [key: string]: unknown; };
  [key: string]: unknown;
}


export interface PieChart {
  type: "pie";
  title?: string | null;
  stream?: StreamSpec;
  /**
   * true for the default hole fraction, or the hole radius as a fraction of the outer radius
   * Schema constraints this type cannot express: exclusiveMinimum=0, exclusiveMaximum=1
   */
  donut?: boolean | number;
  slices?: Array<Slice>;
}


export interface BarChart {
  type: "bar";
  title?: string | null;
  stream?: StreamSpec;
  stacked?: boolean;
  log?: boolean;
  orient?: "v" | "h";
  catLabel?: string | null;
  valLabel?: string | null;
  categories?: Array<string>;
  series?: Array<BarSeries>;
}


export interface LineChart {
  type: "line";
  title?: string | null;
  stream?: StreamSpec;
  x?: "linear" | "time";
  log?: boolean;
  markers?: boolean;
  xLabel?: string | null;
  yLabel?: string | null;
  domain?: DomainPolicy;
  sampling?: SamplingPolicy;
  dateNames?: DateNames;
  timeFormats?: TimeFormats;
  series?: Array<LineSeries>;
}


export interface ScatterChart {
  type: "scatter";
  title?: string | null;
  stream?: StreamSpec;
  xLog?: boolean;
  yLog?: boolean;
  refY?: number;
  refLabel?: string | null;
  xLabel?: string | null;
  yLabel?: string | null;
  points?: Array<Point>;
}


export interface CandlestickChart {
  type: "candlestick";
  title?: string | null;
  stream?: StreamSpec;
  xLabel?: string | null;
  yLabel?: string | null;
  domain?: DomainPolicy;
  dateNames?: DateNames;
  timeFormats?: TimeFormats;
  candles?: Array<Candle>;
}


export interface RadarChart {
  type: "radar";
  title?: string | null;
  stream?: StreamSpec;
  /**
   * Schema constraints this type cannot express: exclusiveMinimum=0
   */
  max?: number;
  axes?: Array<string>;
  series?: Array<ValueSeries>;
}


export interface GaugeChart {
  type: "gauge";
  title?: string | null;
  stream?: StreamSpec;
  value?: number;
  min?: number;
  max?: number;
  unit?: string | null;
  tone?: Tone;
}


export interface BoxplotChart {
  type: "boxplot";
  title?: string | null;
  stream?: StreamSpec;
  catLabel?: string | null;
  valLabel?: string | null;
  boxes?: Array<Box>;
}


export interface HeatmapChart {
  type: "heatmap";
  title?: string | null;
  stream?: StreamSpec;
  log?: boolean;
  xLabel?: string | null;
  yLabel?: string | null;
  xLabels?: Array<string>;
  yLabels?: Array<string>;
  /**
   * values[yi][xi], row-major from the top row; null marks a missing cell
   */
  values?: Array<Array<number | null>>;
}


export interface TreemapChart {
  type: "treemap";
  title?: string | null;
  stream?: StreamSpec;
  /**
   * Schema constraints this type cannot express: exclusiveMinimum=0
   */
  aspect?: number;
  /**
   * leaves, or one level of groups; a chart with any group treats a bare leaf as a group of one
   */
  items?: Array<TreemapItem | TreemapGroup>;
}


export interface StreamgraphChart {
  type: "streamgraph";
  title?: string | null;
  stream?: StreamSpec;
  xLabel?: string | null;
  xs?: Array<number>;
  series?: Array<ValueSeries>;
}


export interface SankeyChart {
  type: "sankey";
  title?: string | null;
  stream?: StreamSpec;
  nodes?: Array<string | { name: string; [key: string]: unknown; }>;
  links?: Array<SankeyLink>;
}


export interface MapChart {
  type: "map";
  title?: string | null;
  stream?: StreamSpec;
  /**
   * feature property to shade by; absent leaves the map unshaded
   */
  value?: string;
  /**
   * feature property to name features by (default 'name')
   */
  label?: string;
  log?: boolean;
  /**
   * Schema constraints this type cannot express: exclusiveMinimum=0
   */
  aspect?: number;
  /**
   * Douglas-Peucker tolerance as a fraction of the frame's width, or false to keep every vertex
   * Schema constraints this type cannot express: minimum=0
   */
  simplify?: number | boolean;
  /**
   * GeoJSON: a FeatureCollection, or an array of Features or geometries
   */
  features?: { [key: string]: unknown; } | Array<unknown>;
  points?: Array<MapPoint>;
}


export type ChartDefinition = PieChart | BarChart | LineChart | ScatterChart | CandlestickChart | RadarChart | GaugeChart | BoxplotChart | HeatmapChart | TreemapChart | StreamgraphChart | SankeyChart | MapChart;


export interface ChartDefinitions {
  pie: PieChart;
  bar: BarChart;
  line: LineChart;
  scatter: ScatterChart;
  candlestick: CandlestickChart;
  radar: RadarChart;
  gauge: GaugeChart;
  boxplot: BoxplotChart;
  heatmap: HeatmapChart;
  treemap: TreemapChart;
  streamgraph: StreamgraphChart;
  sankey: SankeyChart;
  map: MapChart;
}
export type ChartKind = keyof ChartDefinitions;
type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export type ChartOptions<K extends ChartKind> = Omit<Immutable<ChartDefinitions[K]>, 'type'>;
export type ChartPen<K extends ChartKind> = ChartBuilder<K> & {
  readonly [P in keyof ChartOptions<K>]-?: (value: Exclude<ChartOptions<K>[P], undefined>) => ChartPen<K>;
};
/** The kind controls the available fluent members and their value types. */
export class ChartBuilder<K extends ChartKind = ChartKind> {
  protected constructor();
  readonly schema: Immutable<ChartDefinitions[K]>;
  toJSON(): Immutable<ChartDefinitions[K]>;
  options(value: ChartOptions<K>): ChartPen<K>;
}
/** A raw public chart definition; extensions remain JSON and engine-validated. */
export function from<K extends ChartKind>(document: ChartDefinitions[K]): ChartPen<K>;
/** A pie chart definition. */
export function pie(options?: ChartOptions<'pie'>): ChartPen<'pie'>;
/** A bar chart definition. */
export function bar(options?: ChartOptions<'bar'>): ChartPen<'bar'>;
/** A line chart definition. */
export function line(options?: ChartOptions<'line'>): ChartPen<'line'>;
/** A scatter chart definition. */
export function scatter(options?: ChartOptions<'scatter'>): ChartPen<'scatter'>;
/** A candlestick chart definition. */
export function candlestick(options?: ChartOptions<'candlestick'>): ChartPen<'candlestick'>;
/** A radar chart definition. */
export function radar(options?: ChartOptions<'radar'>): ChartPen<'radar'>;
/** A gauge chart definition. */
export function gauge(options?: ChartOptions<'gauge'>): ChartPen<'gauge'>;
/** A boxplot chart definition. */
export function boxplot(options?: ChartOptions<'boxplot'>): ChartPen<'boxplot'>;
/** A heatmap chart definition. */
export function heatmap(options?: ChartOptions<'heatmap'>): ChartPen<'heatmap'>;
/** A treemap chart definition. */
export function treemap(options?: ChartOptions<'treemap'>): ChartPen<'treemap'>;
/** A streamgraph chart definition. */
export function streamgraph(options?: ChartOptions<'streamgraph'>): ChartPen<'streamgraph'>;
/** A sankey chart definition. */
export function sankey(options?: ChartOptions<'sankey'>): ChartPen<'sankey'>;
/** A map chart definition. */
export function map(options?: ChartOptions<'map'>): ChartPen<'map'>;
