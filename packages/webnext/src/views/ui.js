//@ts-check
/**
 * The generic render-node vocabulary — mode 'ui'. The benchmark
 * boundary (and anything else) emits kind-tagged JSON nodes; these
 * three-and-a-half rules turn them into vnodes. Adding a page section
 * becomes a data transformation, not new markup code.
 */

export const UI_RULES = [
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
];
