//@ts-check
/**
 * The generic render-node vocabulary — mode 'ui'. Boundaries (and the
 * docs content) emit kind-tagged JSON nodes; one rule per kind turns
 * them into vnodes. This is the site's component library, as data:
 * cards, tables, callouts, code blocks, error blocks, bar charts,
 * collapsibles, a search box and a show-more button.
 */

/**
 * The rule for one deep-linkable tab in a `nav.tabs` strip. Each page
 * holds its tab entries (`{ href, label, active }`) at a different
 * location, hence the match parameter.
 * @param {string} match - the JSONPath to the tab entries.
 * @param {string} mode - the page's dispatch mode.
 */
export const tabRule = (match, mode) => ({
  match, mode,
  body: ['a', {
    href: '$.href',
    class: { $if: ['$.active', 'tab active', 'tab'] },
  }, '$.label'],
});

export const UI_RULES = [
  {
    match: "$..[?@.kind == 'p']", mode: 'ui',
    body: ['p', { class: 'doc-p' }, '$.text'],
  },
  {
    match: "$..[?@.kind == 'cards']", mode: 'ui',
    body: ['div', { class: 'cards' }, [{ $apply: '$.items[*]' }]],
  },
  {
    match: "$..[?@.kind == 'card']", mode: 'ui',
    body: ['div', { class: 'stat-card' },
      ['p', { class: 'stat-title' }, '$.title'],
      ['p', { class: 'stat-value' }, '$.value'],
      { $if: ['$.note', ['p', { class: 'stat-note' }, '$.note']] },
    ],
  },
  {
    match: "$..[?@.kind == 'table']", mode: 'ui',
    body: ['div', { class: 'table-card' },
      ['h3', {}, '$.title'],
      ['div', { class: 'table-scroll' },
        ['table', {},
          ['thead', {}, ['tr', {}, [{ $apply: '$.head[*]' }]]],
          ['tbody', {}, [{ $apply: '$.rows[*]' }]],
        ],
      ],
      { $if: ['$.note', ['p', { class: 'table-note' }, '$.note']] },
    ],
  },
  {
    match: "$..[?@.kind == 'table']..head[*]", mode: 'ui',
    body: ['th', {}, '$'],
  },
  {
    match: "$..[?@.kind == 'row']", mode: 'ui',
    body: ['tr', { class: { $if: ['$.strong', 'strong', ''] } }, [{ $apply: '$.cells[*]' }]],
  },
  {
    match: "$..[?@.kind == 'row']..cells[*]", mode: 'ui',
    body: ['td', {}, '$'],
  },
  {
    match: "$..[?@.kind == 'callout']", mode: 'ui',
    body: ['div', { class: 'callout' },
      ['h3', {}, '$.title'],
      ['p', {}, '$.text'],
      { $if: ['$.href', ['a', { href: '$.href', class: 'btn' }, '$.link']] },
    ],
  },
  {
    match: "$..[?@.kind == 'code']", mode: 'ui',
    body: ['div', { class: 'code-card' },
      { $if: [{ $or: ['$.title', '$.badge'] },
        ['div', { class: 'code-head' },
          { $if: ['$.title', ['span', { class: 'code-title' }, '$.title']] },
          { $if: ['$.badge', ['span', { class: 'code-badge' }, '$.badge']] },
        ]] },
      ['pre', { class: 'code-block' }, ['code', {}, '$.text']],
    ],
  },
  {
    match: "$..[?@.kind == 'error']", mode: 'ui',
    body: ['div', { class: 'error-card' },
      ['p', { class: 'error-title' }, '$.title'],
      ['p', { class: 'error-message' }, '$.message'],
      { $if: ['$.detail', ['p', { class: 'error-detail' }, '$.detail']] },
    ],
  },
  {
    match: "$..[?@.kind == 'details']", mode: 'ui',
    body: ['details', { class: 'details-card' },
      ['summary', {}, '$.summary'],
      [{ $apply: '$.items[*]' }],
    ],
  },
  {
    // The chart card embeds a ready-made SVG vnode from
    // @jarenjs/charts — the value splices in verbatim, no dispatch.
    match: "$..[?@.kind == 'chart']", mode: 'ui',
    body: ['div', { class: 'chart-card' },
      { $if: ['$.title', ['h3', {}, '$.title']] },
      '$.vnode',
      { $if: ['$.note', ['p', { class: 'table-note' }, '$.note']] },
    ],
  },
  {
    match: "$..[?@.kind == 'search']", mode: 'ui',
    body: ['input', {
      type: 'search',
      class: 'search-input',
      placeholder: '$.placeholder',
      value: '$.value',
      on: { input: '$.action' },
    }],
  },
  {
    match: "$..[?@.kind == 'more']", mode: 'ui',
    body: ['div', { class: 'more-row' },
      ['button', { type: 'button', class: 'btn', on: { click: '$.action' } }, '$.label'],
    ],
  },
];
