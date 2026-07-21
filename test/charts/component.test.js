//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { createChartComponent } from '@jarenjs/charts/component';

const CONFIG = { type: 'pie', title: 'Memo' };
const DATA = { slices: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] };

describe('createChartComponent', function () {
  it('view() is reference-equal for the same data object', function () {
    const charts = createChartComponent();
    const v1 = charts.view(CONFIG, DATA);
    const v2 = charts.view(CONFIG, DATA);
    assert.equal(v1, v2);
    assert.equal(v1[0], 'svg');
  });

  it('a fresh data object re-renders (streaming snapshots)', function () {
    const charts = createChartComponent();
    const v1 = charts.view(CONFIG, { slices: DATA.slices });
    const v2 = charts.view(CONFIG, { slices: DATA.slices });
    assert.notEqual(v1, v2);
  });

  it('structurally-equal configs share the memo entry for one data object', function () {
    const charts = createChartComponent();
    const v1 = charts.view({ type: 'pie', title: 'Memo' }, DATA);
    const v2 = charts.view({ title: 'Memo', type: 'pie' }, DATA);
    assert.equal(v1, v2);
  });

  it('a different config on the same data renders separately', function () {
    const charts = createChartComponent();
    const v1 = charts.view(CONFIG, DATA);
    const v2 = charts.view({ type: 'pie', title: 'Other' }, DATA);
    assert.notEqual(v1, v2);
  });

  it('self-contained definitions (data defaults to config) work', function () {
    const charts = createChartComponent();
    const config = { type: 'pie', slices: [{ label: 'x', value: 1 }] };
    assert.equal(charts.view(config), charts.view(config));
  });

  it('null and undefined configs project to null', function () {
    const charts = createChartComponent();
    assert.equal(charts.view(null), null);
    assert.equal(charts.view(undefined), null);
  });

  it('the theme option flows through to the render', function () {
    const charts = createChartComponent({ theme: 'host' });
    const v = charts.view(CONFIG, DATA);
    assert.equal(v[1].style['--chart-text'], 'var(--fg, #1f2020)');
  });
});
