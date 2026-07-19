//@ts-check
/**
 * The generic render-node vocabulary — mode 'ui'. Boundaries (and the
 * docs content) emit kind-tagged JSON nodes; one rule per kind turns
 * them into vnodes. This is the site's component library, as data:
 * cards, tables, callouts, code blocks, error blocks, bar charts,
 * collapsibles, a search box and a show-more button.
 */

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
    match: "$..[?@.kind == 'bars']", mode: 'ui',
    body: ['div', { class: 'bars-card' },
      ['h3', {}, '$.title'],
      [{ $apply: '$.items[*]' }],
      { $if: ['$.note', ['p', { class: 'table-note' }, '$.note']] },
    ],
  },
  {
    match: "$..[?@.kind == 'bar']", mode: 'ui',
    body: ['div', { class: 'bar-row' },
      ['span', { class: 'bar-label' }, '$.label'],
      ['div', { class: 'bar-track' },
        ['div', {
          class: { $if: [{ $eq: ['$.tone', 'loss'] }, 'bar-fill loss', 'bar-fill'] },
          style: '$.style',
        }]],
      ['span', { class: 'bar-text' }, '$.text'],
    ],
  },
  {
    // The Markdown preview embeds a ready-made vnode from @jarenjs/md —
    // the value splices in verbatim, no dispatch into it.
    match: "$..[?@.kind == 'markdown']", mode: 'ui',
    body: ['div', { class: 'code-card md-preview' },
      { $if: ['$.title', ['div', { class: 'code-head' },
        ['span', { class: 'code-title' }, '$.title']]] },
      '$.vnode',
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
