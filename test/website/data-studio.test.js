//@ts-check
/**
 * @file The data studio's PAGE half: what the model pane's edits do to
 * the rest of the surface.
 *
 * The model is editable, so nothing downstream may name a collection
 * literally — the seed, the row read, the query and explain pair and the
 * live subscription all follow the collection the OPEN model declares,
 * and the row list addresses documents by the key pointer that model
 * declares too. What the worker does with those requests is
 * `data-handlers.test.js`; this is the state and the view model.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { createSiteApp } from '../../packages/website/src/app/createSiteApp.js';
import {
  dataViewModel, tripPipeline, previewVnode, tripSummary, TRIP_CSV, TRIP_REGION, TRIP_MODEL,
} from '../../packages/website/src/boundaries/data.js';
import { getFormatInfo } from '@jarenjs/forms';
import { isValidGeoJson } from '@jarenjs/core/geo';
import { parseHash } from '../../packages/website/src/lib/route.js';
import { createStubHost, serialize } from '../view/dom.stub.js';

/** The site headless on `#/data`; the worker never boots in Node, which
 * is exactly why the state transitions are asserted directly. */
function mount() {
  const { document, container } = createStubHost();
  const app = createSiteApp({
    node: container,
    document,
    schedule: (/** @type {any} */ f) => f(),
    debounceMs: 0,
    fetchJson: () => Promise.reject(new Error('404')),
    listenHash: (/** @type {any} */ cb) => cb(parseHash('#/data')),
    navigate: () => {},
    onError: (/** @type {any} */ error) => { throw error; },
  });
  return { app, container };
}

const CAPABILITIES = { capture: 'journal', version: '3', operators: [], pushableOperators: [] };

describe('the collection the studio works on', function () {
  it('stays on the seed model\'s when an open answers nothing about it', function () {
    const { app } = mount();
    app.dispatch('data/opened', { vfs: 'x', capabilities: CAPABILITIES });
    assert.strictEqual(app.getState().data.collection, 'notes');
    assert.strictEqual(app.getState().data.keyPointer, '/id');
  });

  it('follows a reopened model — collection and key pointer both', function () {
    const { app } = mount();
    app.dispatch('data/opened', {
      vfs: 'x', collection: 'tasks', keyPointer: '/uid', capabilities: CAPABILITIES,
    });
    assert.strictEqual(app.getState().data.collection, 'tasks',
      'naming a collection literally downstream made editing the model produce a studio'
      + ' that queries one the model no longer declares');
    assert.strictEqual(app.getState().data.keyPointer, '/uid');
    const model = dataViewModel(app.getState());
    assert.strictEqual(model.collection, 'tasks');
    assert.match(model.insertPlaceholder, /new tasks title/);
  });
});

describe('the stored documents, as the store pane lists them', function () {
  const state = (rows, keyPointer = '/id', collection = 'notes') => ({
    data: {
      status: 'ready', topology: 'owner', vfs: 'x', version: '3', capture: 'journal',
      operators: [], pushableOperators: [], refusal: null, modelText: '', queryText: '',
      collection, keyPointer, rows, results: [], explain: null,
      live: { rows: [], seq: null, regs: null }, insertDraft: '', migration: null, error: null,
      trip: { csv: '', report: null },
      mobilePane: 'query',
    },
  });

  it('addresses each document by the pointer the MODEL declares', function () {
    const model = dataViewModel(state(
      [{ uid: 'a', title: 'first' }, { uid: 'b', title: 'second' }], '/uid'));
    assert.deepStrictEqual(model.rowList.map((/** @type {any} */ row) => row.key), ['a', 'b']);
    assert.strictEqual(model.rowList[0].text, '{"uid":"a","title":"first"}');
    assert.strictEqual(model.rowSummary, '2 stored in notes');
  });

  it('leaves a document the pointer misses without a key, so no control addresses nothing', function () {
    const model = dataViewModel(state([{ id: 'a' }, { other: 'b' }]));
    assert.strictEqual(model.rowList[0].key, 'a');
    assert.strictEqual(Object.hasOwn(model.rowList[1], 'key'), false,
      'a delete button with nothing to address is a button that quietly does nothing');
  });

  it('renders one row per document, with a delete on each that has a key', function () {
    const { app, container } = mount();
    app.dispatch('data/rows', { rows: [{ id: 'n1', title: 'first' }, { nokey: true }] });
    const html = serialize(container);
    assert.strictEqual(html.match(/class="data-row"/g)?.length, 2,
      'one row per stored document');
    assert.strictEqual(html.match(/data-row-delete/g)?.length, 1,
      'and a control only where there is a key to address');
    assert.match(html, /2 stored in notes/,
      'the summary counts the documents, not the ones it could address');
  });
});

describe('the spatial round trip — the pure half, and what the page makes of the report', function () {
  it('runs CSV → stylesheet → meta-schema → the linq document, with no store', function () {
    const trip = tripPipeline(TRIP_CSV);
    assert.strictEqual(trip.rows.length, 5, 'five typed rows');
    assert.strictEqual(typeof trip.rows[0].lon, 'number', 'typed: a coordinate is a number');
    assert.strictEqual(trip.collection.type, 'FeatureCollection');
    assert.strictEqual(trip.valid, true, 'the meta-schema accepts what the stylesheet made');
    assert.strictEqual(isValidGeoJson(trip.collection), true, 'and so does the one-call judgment');
    assert.deepStrictEqual(trip.documents.map((f) => f.properties.name),
      ['Amsterdam', 'Utrecht', 'Rotterdam', 'Paris', 'Berlin']);
    // the query is the chain's document: a $within over the geometry,
    // the region bound as an external — the shape an index is probed with
    assert.deepStrictEqual(trip.query, {
      $for: { it: '$[*]' },
      $where: { $within: ['$it.geometry', '$region'] },
      $return: '$it',
    });
    assert.deepStrictEqual(trip.externals, { region: TRIP_REGION });
    assert.strictEqual(trip.model, TRIP_MODEL);
    assert.deepStrictEqual(trip.model.collections.places.indexes.map((i) => i.derive), ['geohash', 'bbox'],
      'both derived kinds: the cell for a probe, the box for the $within push');
  });

  it('refuses a row the meta-schema refuses, naming the position', function () {
    const trip = tripPipeline('name,lon,lat,pop\nNowhere,200,1,0');
    assert.strictEqual(trip.valid, false);
    assert.ok(trip.errors.length > 0 && trip.errors.length <= 8);
    assert.ok(trip.errors.some((e) => /coordinates|features/.test(e.instancePath) || /coordinates/.test(e.message)),
      `the errors point into the document: ${JSON.stringify(trip.errors)}`);
    assert.deepStrictEqual(trip.documents, [], 'nothing invalid reaches a store');
  });

  it('draws the geojson format\'s preview hint through this host\'s map renderer — and nothing for a kind it lacks', function () {
    const hint = getFormatInfo('geojson').preview;
    assert.deepStrictEqual(hint, { kind: 'map' }, 'the hint is the forms registry\'s, not the studio\'s');
    const trip = tripPipeline(TRIP_CSV);
    const vnode = previewVnode(hint, trip.collection, 'preview');
    assert.ok(Array.isArray(vnode) && vnode[0] === 'svg', 'a map, as a pure vnode');
    assert.ok(JSON.stringify(vnode).includes('circle'), 'the five points are drawn');
    assert.strictEqual(previewVnode({ kind: 'hologram' }, trip.collection, 'x'), null, 'no renderer, no drawing');
    assert.strictEqual(previewVnode(null, trip.collection, 'x'), null);
    assert.strictEqual(previewVnode(undefined, trip.collection, 'x'), null);
  });

  it('seeds the CSV, keeps the report, and lists the round trip beside the other panes', function () {
    const { app, container } = mount();
    app.dispatch('data/seed', { modelText: '{}', queryText: '{}', tripCsv: TRIP_CSV });
    assert.strictEqual(app.getState().data.trip.csv, TRIP_CSV);
    app.dispatch('data/trip-csv', null, { target: { value: 'name,lon,lat' } });
    assert.strictEqual(app.getState().data.trip.csv, 'name,lon,lat');
    assert.strictEqual(dataViewModel(app.getState()).tripStatus, 'idle');
    assert.strictEqual(dataViewModel(app.getState()).trip, null);

    const html = serialize(container);
    assert.match(html, /data-trip-run/, 'the control is rendered');
    assert.match(html, /Round trip/, 'the pane switcher names it');
    assert.doesNotMatch(html, /data-trip-report/, 'no report before a run');
    assert.match(html, /"\$within"/, 'the emitted query document is printed for the reader');
    assert.match(html, /derive/, 'and the model with its derived indexes');
  });

  it('shows the two stages of the plan beside the answer, and the map', function () {
    const trip = tripPipeline(TRIP_CSV);
    const report = {
      status: 'done', rows: 5, features: 5, query: trip.query,
      results: trip.documents.slice(0, 3),
      explain: {
        sql: 'SELECT … WHERE gx_geometry_bbox_w <= ? …',
        params: [], indexes: ['by_box'],
        prefilters: [{ construct: '$within', columns: ['gx_geometry_bbox_w'], exact: false }],
        residual: { mode: 'set', reasons: [{ construct: '$within', reason: 'refined' }] },
        scanNarrative: 'SEARCH places USING INDEX places_by_box (gx_geometry_bbox_w<?)',
      },
    };
    const { app, container } = mount();
    app.dispatch('data/trip', report);
    const model = dataViewModel(app.getState());
    assert.strictEqual(model.tripStatus, 'done');
    assert.strictEqual(model.tripDone, true);
    assert.strictEqual(model.tripSummary, tripSummary(report));
    assert.match(model.tripSummary, /5 CSV rows .* 5 features .* 3 inside the region/);
    assert.match(model.tripPrefilters, /\$within/);
    assert.match(model.tripPrefilters, /"exact":false/, 'the box is a pre-filter, never the answer');
    assert.match(model.tripNarrative, /SEARCH places USING INDEX/);
    assert.strictEqual(model.tripIndexes, 'by_box');
    assert.match(model.tripResidual, /\$within/);
    assert.ok(Array.isArray(model.tripMap) && model.tripMap[0] === 'svg', 'the map is drawn');
    assert.strictEqual(dataViewModel(app.getState()).tripMap, model.tripMap, 'one map per report, not per render');

    const html = serialize(container);
    assert.match(html, /data-trip-report/);
    assert.match(html, /data-status="done"/);
    assert.match(html, /data-trip-narrative/);
    assert.match(html, /<svg/, 'the map reaches the page');
    assert.match(html, /Amsterdam/, 'and so does the result');

    app.dispatch('data/trip', { status: 'error', rows: 1, message: 'the stylesheet\'s output is not GeoJSON' });
    const failed = dataViewModel(app.getState());
    assert.strictEqual(failed.tripDone, false);
    assert.match(failed.tripSummary, /stopped: the stylesheet/);
    assert.strictEqual(failed.tripMap, null);
    assert.strictEqual(tripSummary({ status: 'running', rows: 5, features: 5 }).includes('running'), true);
    assert.strictEqual(tripSummary(null), '');
  });
});
