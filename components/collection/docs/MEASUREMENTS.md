# Collection evidence

The retained reference fixtures and budgets remain unchanged. The installed
Node/Bun consumer runs both fixed and measured profiles using only public package
exports, without a retained virtualizer dependency. The reference remains in the
benchmark workspace for differential checks and future downstream qualification.

<!--fact:collection.measurements-->

Measured on v24.19.0, linux/x64, AMD Ryzen 9 5900HX with Radeon Graphics.

| Consumer | Rows | Reference range ms | Native range/view/interaction p95 ms | Cells | Cached rows / bytes | Measurements / accounted bytes | Heap MiB | Teardown ms |
|---|---:|---:|---:|---:|---|---|---:|---:|
| catalog | 10000 | 0.020 | 1.450 | 170 | 256 / 9732 | 256 / 8192 | 19.49 | 0.177 |
| archive-stock | 75000 | 8.080 | 0.307 | 160 | 256 / 10244 | 256 / 8448 | 92.43 | 0.047 |

The component and coordinator browser bundle is 16815 gzip bytes. Reference range calls do less work than native vnode and interaction calls; the comparison deliberately publishes that cost rather than claiming equal workloads.

<!--/fact-->

The Node measurements include range calculation, vnode projection and headless
interaction. The reference timing is range-only and is therefore cheaper work.
The historical adoption report also includes other engines; its heap and RSS
cannot be treated as isolated virtualizer memory. Measurement bytes account for
UTF-8 keys and numeric payloads; runtime heap separately includes Map/array overhead.

The browser matrix covers keyed anchor preservation, both axes, RTL, pinned rows,
resize, CSS zoom, synthetic touch events, keyboard selection, pending realization,
editing/composition events, extent limits, source examples and disposal. The
near-ceiling fixture uses lazy row access. It never allocates the entire logical
source in the browser. Browser script timings cover synchronous DOM reconciliation;
paint scheduling is separate. Physical touch devices, actual assistive technology,
native OS IME sessions and real downstream cutover remain unqualified.

<!--fact:collection.browser-->

Linux container, Node v24.20.0, 4 browser workers. Each sample set contains 40 synchronous viewport changes after the near-ceiling check.

| Engine / version | DOM interaction p95 ms | Earlier full-matrix p95 ms | Peak cells | CSS extent / final offset | Remaining resources |
|---|---:|---:|---:|---|---:|
| chromium 149.0.7827.55 | 10.30 | 8.60 | 170 | 7920000 / 7919560 | 0 |
| firefox 151.0 | 11.00 | 12.00 | 170 | 7920000 / 7919560 | 0 |
| webkit 26.5 | 15.00 | 17.00 | 170 | 7920000 / 7919560 | 0 |

The earlier loaded WebKit sample exceeded the fixed-profile 16 ms target. Browser latency varies with concurrent load; these measurements do not establish a universal frame-time guarantee.

<!--/fact-->

Reproduce the portable and Node measurements with `npm run test:packed` and
`npm run benchmark:collection`. After `npm run website:build`, run
`COLLECTION_MEASURE=1 npx playwright test -c packages/website/playwright.config.js packages/website/e2e/collection.spec.js packages/website/e2e/lifecycle.spec.js --workers=4`
on the qualified browser host, then `npm run docs:derive`. Ordinary gates omit the
measurement environment variable and leave committed timings unchanged. The earlier
full-matrix sample is retained separately so rerunning does not erase a measured loss.
True peak heap remains unmeasured; sampled heap and process peak RSS are reported.

The browser's conservative CSS extent ceiling refuses larger extents before they
reach layout. The pure range engine supports larger logical counts. Source-backed
sequential providers retain unknown totals and refuse index/key jumps and complete
export. Complete export is qualified for immutable resident array sources and
bounded complete SQLite resident snapshots. The browser download example uses a
finite output spool and refuses an oversized export before making a download.
