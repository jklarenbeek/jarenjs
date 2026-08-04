//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import { JarenValidator } from '@jarenjs/validate';
import {
  downlevelDraft07,
  draftNeutralSubsetViolations,
  mapRefs,
} from '../json/schema-artifact-helpers.js';

const load = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

const querySchema = load('../../packages/json/schemas/jaren-query.schema.json');
const jsltSchema = load('../../packages/json/schemas/jaren-jslt.schema.json');
const querySchema07 = load('../../packages/json/schemas/jaren-query.draft-07.schema.json');
const jsltSchema07 = load('../../packages/json/schemas/jaren-jslt.draft-07.schema.json');
const appSchema = load('../../packages/app/schemas/jaren-app.schema.json');
const appSchema07 = load('../../packages/app/schemas/jaren-app.draft-07.schema.json');
const vnodeSchema = load('../../packages/view/schemas/jaren-vnode.schema.json');

function compileApp() {
  return new JarenValidator()
    .addSchema(querySchema)
    .addSchema(jsltSchema)
    .compile(appSchema);
}

const COUNTER_DOC = {
  $app: '0.1',
  state: { count: 0 },
  view: [
    { match: '$', body: ['main', {}, ['h1', {}, 'Count: ', '$.count'], ['button', { on: { click: 'inc' } }, '+']] },
  ],
  actions: {
    inc: { patch: [{ op: 'replace', path: '/count', value: { $add: ['$.count', 1] } }] },
  },
  subs: [{ run: 'interval', with: { ms: 1000 }, when: '$.running' }],
};

describe('the jaren-app meta-schema', function () {
  it('accepts the README counter document', function () {
    const validate = compileApp();
    assert.strictEqual(validate(COUNTER_DOC), true);
  });

  it('accepts THE WEBSITE — the deployed app document validates whole', async function () {
    const { STYLESHEET } = await import('../../packages/website/src/views/index.js');
    const { ACTIONS, SUBS } = await import('../../packages/website/src/app/actions.js');
    const { createInitialState } = await import('../../packages/website/src/app/state.js');
    const validate = compileApp();
    const siteDoc = {
      $app: '0.1',
      state: createInitialState(),
      view: STYLESHEET,
      actions: ACTIONS,
      subs: SUBS,
    };
    assert.strictEqual(validate(siteDoc), true,
      'the entire production website is one valid jaren-app document');
  });

  it('rejects structural mistakes with the composed grammars', function () {
    const validate = compileApp();
    assert.strictEqual(validate({}), false, 'view is required');
    assert.strictEqual(validate({ $app: '0.2', view: [] }), false, 'unknown version');
    assert.strictEqual(
      validate({ view: [], actions: { bad: { $bogus: [1] } } }),
      false, 'unknown operator rejected by the query grammar');
    assert.strictEqual(
      validate({ view: [], subs: [{ with: {} }] }),
      false, 'a sub needs its handler name');
    assert.strictEqual(
      validate({ view: [{ match: 5, body: '$' }] }),
      false, 'a numeric match — rejected by the JSLT grammar');
  });

  it('stays in the draft-neutral subset and its draft-07 twin is in sync', function () {
    assert.deepStrictEqual(draftNeutralSubsetViolations(appSchema), []);
    const twin = downlevelDraft07(appSchema);
    assert.deepStrictEqual(appSchema07, mapRefs(twin),
      'regenerate the committed twin from the canonical artifact');
  });

  it('the draft-07 twin validates through the draft-07 grammar twins', function () {
    const validate = new JarenValidator()
      .addSchema(querySchema07)
      .addSchema(jsltSchema07)
      .compile(appSchema07);
    assert.strictEqual(validate(COUNTER_DOC), true);
    assert.strictEqual(validate({ view: [], actions: { bad: { $bogus: [1] } } }), false);
  });
});

describe('the jaren-vnode schema', function () {
  it('accepts real view output and rejects malformed props', function () {
    const validate = new JarenValidator().compile(vnodeSchema);
    assert.strictEqual(validate(['main', { class: 'x' },
      ['h1', {}, 'Title'],
      [['li', { key: 1, on: { click: 'pick' } }, 'a'], ['li', { key: 2 }, 'b']],
      null, true, 42]), true);
    assert.strictEqual(validate(['div', { style: { color: 'red' } }, 'ok']), true);
    assert.strictEqual(validate(['div', { weird: { nested: 'object' } }]), false,
      'non-special props must be scalars');
  });

  it('publishes the widget shape for constrained decoders', function () {
    const widgetNode = ['jaren-widget', {
      name: 'virtual-grid', props: { rows: [1, 2] }, tag: 'div',
      key: 'grid', class: 'grid-host', on: { click: 'pick' },
    }];
    const validate = new JarenValidator().compile(vnodeSchema);
    assert.strictEqual(validate(widgetNode), true,
      'a widget node is a valid vnode (and stays a valid plain element — backward compatible)');

    const widget = new JarenValidator().addSchema(vnodeSchema)
      .compile({ $ref: 'https://jarenjs.dev/schemas/jaren-vnode/0.1#/$defs/widget' });
    assert.strictEqual(widget(widgetNode), true);
    assert.strictEqual(widget(['jaren-widget', { name: 'grid' }]), true,
      'props alone is enough');
    assert.strictEqual(widget(['jaren-widget', {}]), false, 'name is required');
    assert.strictEqual(widget(['jaren-widget', { name: '' }]), false, 'name is non-empty');
    assert.strictEqual(widget(['jaren-widget', { name: 'grid' }, ['div', {}]]), false,
      'a widget node has no vnode children');
    assert.strictEqual(widget(['div', { name: 'grid' }]), false, 'the tag is reserved');
  });
});
