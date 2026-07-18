//@ts-check
/**
 * The site's actions — every one a Jaren JSON Query document producing
 * a transition (APP-FORMAT §3). Navigation itself needs no actions:
 * links are plain hash anchors and the `hash` subscription dispatches
 * `route/set`. Note how `route/set` computes its fetch effects with
 * `$if` — orchestration as data.
 */

import { createFormActions } from '@jarenjs/app';

export const ACTIONS = {
  // hash changed: store the parsed route and fetch what the page needs
  // (the fetch-bench handler dedupes, so repeat visits are free)
  'route/set': {
    patch: [{ op: 'replace', path: '/route', value: '$payload' }],
    effects: {
      $if: [
        { $eq: ['$payload.page', 'benchmarks'] },
        [
          { run: 'fetch-bench', with: { name: 'meta' } },
          {
            $if: [
              {
                $and: [
                  { $exists: '$payload.params.suite' },
                  { $ne: ['$payload.params.suite', 'overview'] },
                ],
              },
              { run: 'fetch-bench', with: { name: '$payload.params.suite' } },
            ],
          },
        ],
        [],
      ],
    },
  },

  'bench/status': {
    patch: [{
      op: 'add',
      path: { $concat: ['/benchStatus/', '$payload.name'] },
      value: '$payload.status',
    }],
  },

  'bench/loaded': {
    patch: [
      { op: 'add', path: { $concat: ['/bench/', '$payload.name'] }, value: '$payload.data' },
      { op: 'add', path: { $concat: ['/benchStatus/', '$payload.name'] }, value: 'ready' },
    ],
  },

  'theme/toggle': {
    patch: [{
      op: 'replace',
      path: '/theme',
      value: { $if: [{ $eq: ['$.theme', 'dark'] }, 'light', 'dark'] },
    }],
    effects: [{
      run: 'apply-theme',
      with: { theme: { $if: [{ $eq: ['$.theme', 'dark'] }, 'light', 'dark'] } },
    }],
  },

  // playground: the schema editor (live per keystroke, revalidated by
  // the wire() subscriber watching the changed-path feed)
  'pg/schema-text': {
    patch: [{ op: 'replace', path: '/pg/schemaText', value: '$event.value' }],
  },

  // playground: the JSON data pane commits on change (blur)
  'pg/data-text': {
    effects: [{ run: 'parse-data', with: { text: '$event.value' } }],
  },
  'pg/data-set': {
    patch: [
      { op: 'replace', path: '/pg/data', value: '$payload' },
      { op: 'replace', path: '/pg/dataError', value: null },
    ],
  },
  'pg/data-error': {
    patch: [{ op: 'replace', path: '/pg/dataError', value: '$payload' }],
  },

  'pg/result': {
    patch: [{ op: 'replace', path: '/pg/result', value: '$payload' }],
  },
  'pg/data-tab': {
    patch: [{ op: 'replace', path: '/pg/dataTab', value: '$payload' }],
  },
  'pg/locale': {
    patch: [{ op: 'replace', path: '/pg/locale', value: '$payload' }],
  },
  'pg/example': {
    patch: [
      { op: 'replace', path: '/pg/schemaText', value: '$payload.schemaText' },
      { op: 'replace', path: '/pg/data', value: '$payload.data' },
      { op: 'replace', path: '/pg/dataError', value: null },
    ],
  },

  // the generated form writes through the standard form actions
  ...createFormActions({ dataPointer: '/pg/data' }),
};

/** The site's subscriptions: the hash router feed, always live. */
export const SUBS = [{ run: 'hash' }];
