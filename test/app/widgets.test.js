//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createApp } from '@jarenjs/app';
import { createStubHost, fire } from '../view/dom.stub.js';

/** Synchronous render scheduler for deterministic assertions. */
const sync = (flush) => flush();

/**
 * A bounded-DOM virtual list — the grid-behind-a-widget pattern as test
 * infrastructure. The widget owns the host's subtree: it windows
 * `props.rows` to the viewport (plus overscan) and rebuilds only the
 * visible row elements. Selection never invents an action vocabulary:
 * each row click composes the row id into the binding the stylesheet
 * authored (`props.binding`) and hands it to `emit`.
 */
function virtualListWidget(log) {
  const window_ = (handle, props) => {
    const { rows, rowHeight, viewport, overscan, scrollTop, binding } = props;
    const doc = handle.host.ownerDocument;
    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const last = Math.min(rows.length - 1,
      Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
    handle.host.textContent = '';
    for (let i = first; i <= last; i++) {
      const row = doc.createElement('div');
      row.textContent = String(rows[i]);
      const id = rows[i];
      row.addEventListener('click', (event) =>
        handle.emit({ ...binding, with: { ...binding.with, id } }, event));
      handle.host.appendChild(row);
    }
  };
  return {
    mount(host, props, emit) {
      log.push('mount');
      const handle = { host, emit };
      window_(handle, props);
      return handle;
    },
    update(handle, props) {
      log.push('update');
      window_(handle, props);
    },
    unmount() {
      log.push('unmount');
    },
  };
}

/** 10,000 rows behind the widget, all driven by app state. */
function gridDoc() {
  return {
    state: {
      grid: {
        rows: Array.from({ length: 10000 }, (_, i) => `row-${i}`),
        scrollTop: 0,
      },
      selected: null,
      shift: null,
      other: 0,
    },
    view: [
      { match: '$', body: ['main', {}, { $apply: '$.grid' }, ['p', {}, 'sel: ', '$.selected']] },
      {
        match: '$.grid',
        body: ['jaren-widget', {
          name: 'virtual-list', key: 'list', class: 'viewport',
          props: {
            rows: '$.rows', rowHeight: 10, viewport: 100, overscan: 2,
            scrollTop: '$.scrollTop',
            binding: { action: 'select', with: {}, event: ['shiftKey'] },
          },
        }],
      },
    ],
    actions: {
      select: {
        patch: [
          { op: 'add', path: '/selected', value: '$payload.id' },
          { op: 'add', path: '/shift', value: '$event.shiftKey' },
        ],
      },
      scroll: { patch: [{ op: 'replace', path: '/grid/scrollTop', value: '$payload' }] },
      bump: { patch: [{ op: 'replace', path: '/other', value: { $add: ['$.other', 1] } }] },
    },
  };
}

function mountGrid() {
  const log = [];
  const { document, container } = createStubHost();
  const app = createApp(gridDoc(), {
    node: container, document, schedule: sync,
    widgets: { 'virtual-list': virtualListWidget(log) },
  });
  const hostNode = container.childNodes[0].childNodes[0];
  return { app, container, hostNode, log };
}

describe('widgets in the app loop', function () {
  it('an app-document stylesheet renders the widget from state, DOM bounded by the window', function () {
    const { app, hostNode, log } = mountGrid();
    assert.deepStrictEqual(log, ['mount']);
    assert.strictEqual(hostNode.attributes.get('class'), 'viewport');
    assert.strictEqual(app.getState().grid.rows.length, 10000);
    assert.strictEqual(hostNode.childNodes.length, 13,
      '10 viewport rows + 1 boundary + 2 overscan — not 10,000');
    assert.strictEqual(hostNode.childNodes[0].childNodes[0].nodeValue, 'row-0');
  });

  it('scrolling re-windows through update; the DOM stays bounded', function () {
    const { app, hostNode, log } = mountGrid();
    app.dispatch('scroll', 50000);
    assert.deepStrictEqual(log, ['mount', 'update']);
    assert.strictEqual(hostNode.childNodes[0].childNodes[0].nodeValue, 'row-4998');
    assert.ok(hostNode.childNodes.length <= 16,
      `DOM row count stays bounded (got ${hostNode.childNodes.length})`);
  });

  it('a widget emit of a composed { action, with } binding transitions state', function () {
    const { app, hostNode, log } = mountGrid();
    fire(hostNode.childNodes[5], 'click');
    assert.strictEqual(app.getState().selected, 'row-5');
    assert.strictEqual(app.getState().shift, null,
      'the stub event has no shiftKey member — undefined coerces to null');
    assert.deepStrictEqual(log, ['mount'],
      'the selection lives outside $.grid, so the widget was not poked');
  });

  it('a widget-forwarded native event resolves the binding\'s requested fields', function () {
    const { app, hostNode } = mountGrid();
    fire(hostNode.childNodes[3], 'click', { shiftKey: true });
    assert.strictEqual(app.getState().selected, 'row-3');
    assert.strictEqual(app.getState().shift, true,
      '$event.shiftKey crossed the widget boundary as data');
  });

  it('with the JSLT memo, a transition outside the widget\'s state slice produces zero widget calls', function () {
    const { app, log } = mountGrid();
    app.dispatch('bump');
    app.dispatch('bump');
    assert.strictEqual(app.getState().other, 2);
    assert.deepStrictEqual(log, ['mount'],
      'reference-equal props: the widget was never called');
  });
});
