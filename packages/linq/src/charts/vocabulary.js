// Derived from chart-definition.schema.json by scripts/generate-chart-pen.js.
/** The known member set for each public chart discriminator. */
export const CHART_FIELDS = Object.freeze({
  "pie": [
    "title",
    "stream",
    "donut",
    "slices"
  ],
  "bar": [
    "title",
    "stream",
    "stacked",
    "log",
    "orient",
    "catLabel",
    "valLabel",
    "categories",
    "series"
  ],
  "line": [
    "title",
    "stream",
    "x",
    "log",
    "markers",
    "xLabel",
    "yLabel",
    "domain",
    "sampling",
    "dateNames",
    "timeFormats",
    "series"
  ],
  "scatter": [
    "title",
    "stream",
    "xLog",
    "yLog",
    "refY",
    "refLabel",
    "xLabel",
    "yLabel",
    "points"
  ],
  "candlestick": [
    "title",
    "stream",
    "xLabel",
    "yLabel",
    "domain",
    "dateNames",
    "timeFormats",
    "candles"
  ],
  "radar": [
    "title",
    "stream",
    "max",
    "axes",
    "series"
  ],
  "gauge": [
    "title",
    "stream",
    "value",
    "min",
    "max",
    "unit",
    "tone"
  ],
  "boxplot": [
    "title",
    "stream",
    "catLabel",
    "valLabel",
    "boxes"
  ],
  "heatmap": [
    "title",
    "stream",
    "log",
    "xLabel",
    "yLabel",
    "xLabels",
    "yLabels",
    "values"
  ],
  "treemap": [
    "title",
    "stream",
    "aspect",
    "items"
  ],
  "streamgraph": [
    "title",
    "stream",
    "xLabel",
    "xs",
    "series"
  ],
  "sankey": [
    "title",
    "stream",
    "nodes",
    "links"
  ],
  "map": [
    "title",
    "stream",
    "value",
    "label",
    "log",
    "aspect",
    "simplify",
    "features",
    "points"
  ]
});
