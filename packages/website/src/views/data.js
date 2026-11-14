//@ts-check
import { DATA_RULES as shared } from '@jarenjs/studio/data';
export const DATA_RULES = [shared[0], { ...shared[1], body: ['section', { class: 'page container data-page' },
      ['h1', {}, '$.title'],
      // the page's lead is prose, English by design
      ['p', { class: 'lead', lang: 'en', dir: 'ltr' },
        'The same store, the same queries, the same live updates as Node and Bun — running here, in your browser, on the official SQLite wasm build. One tab owns the connection; more tabs become clients.'],
  shared[1].body,
] }];
