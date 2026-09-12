//@ts-check
import { DATA_RULES as shared } from '@jarenjs/studio/data';
export const DATA_RULES = [shared[0], { ...shared[1], body: ['section', { class: 'page container data-page' },
      ['h1', {}, 'Data'],
      ['p', { class: 'lead' },
        'The same store, the same queries, the same live updates as Node and Bun — running here, in your browser, on the official SQLite wasm build. One tab owns the connection; more tabs become clients.'],
  shared[1].body,
] }];
