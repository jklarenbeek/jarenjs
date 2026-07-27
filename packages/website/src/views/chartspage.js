//@ts-check
/**
 * The /charts page — mode 'charts', dispatched with `$.ui.chartsPage`
 * as the current node. Thin like the benchmarks page: two sections of
 * kind-nodes from the chartspage/binance boundaries, rendered by the
 * generic 'ui' mode.
 */

export const CHARTSPAGE_RULES = [
  {
    match: '$.ui.chartsPage', mode: 'charts',
    body: ['div', { class: 'page container' },
      ['h1', {}, 'Charts'],
      ['p', { class: 'page-lead' },
        'Headless SVG charts from the @jarenjs/charts engine: a definition document compiles to a geometry-free AST and renders as pure vnodes — no browser needed, themed live by the site tokens. The benchmarks page and the mermaid pie run on the same engine.'],
      ['section', { class: 'charts-live' },
        ['h2', {}, 'Live — real market data through the streaming reader'],
        ['p', { class: 'doc-p' },
          'Every WebSocket message below is parsed by createJsonxStreamReader in strict-JSON mode and accumulated by the stream adapter — the exact code path of the playground replay, on a real feed.'],
        [{ $apply: ['$.live[*]', 'ui'] }],
      ],
      ['section', { class: 'charts-demos' },
        ['h2', {}, 'Every chart type'],
        [{ $apply: ['$.demos[*]', 'ui'] }],
      ],
    ],
  },
];
