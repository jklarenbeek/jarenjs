//@ts-check
import { createDomRenderer } from '@jarenjs/view';
import { logicalScrollOffset } from '@jarenjs/core/virtual';
import { createCollection, collectionItemId } from '../collection.js';
import { createCollectionInteraction } from '../interaction.js';
let nextId = 0;

/**
 * Mount a collection with injected source access, optional frame and resize ownership.
 * CSS extents above the qualified ceiling refuse before they reach layout.
 * @param {HTMLElement} host @param {any} options
 */
export function mountCollection(host, options) {
  let config = { maxExtent: 8000000, maxMeasurementWork: 64, ...options };
  if (!Number.isSafeInteger(config.maxMeasurementWork) || config.maxMeasurementWork < 1
    || !Number.isFinite(config.maxExtent) || config.maxExtent <= 0) throw new RangeError('Invalid measurement/extent credits');
  const document = host.ownerDocument, window = document.defaultView;
  const requestFrame = config.requestFrame ?? ((fn) => window.requestAnimationFrame(fn));
  const cancelFrame = config.cancelFrame ?? ((id) => window.cancelAnimationFrame(id));
  const observe = config.observe ?? ((element, fn) => {
    const observer = new window.ResizeObserver(fn); observer.observe(element);
    return () => observer.disconnect();
  });
  const element = document.createElement('div');
  element.className = 'jc-viewport';
  element.style.overflow = 'auto'; element.style.position = 'relative';
  element.style.height = `${config.height ?? 440}px`;
  element.style.overflowAnchor = 'none';
  element.tabIndex = 0;
  const id = config.id ?? `jc-${++nextId}`;
  const controller = createCollection(config);
  const interaction = createCollectionInteraction(controller.options());
  const render = createDomRenderer(element, { document, onEvent: config.onEvent });
  let frame = null, disposed = false, composing = false, unobserve = null, measurePending = false, measurementCursor = 0;
  const observed = new Map();
  function schedule() { if (!disposed && frame === null) frame = requestFrame(refresh); }
  function focusId() {
    const focus = interaction.state().focus;
    if (!focus) return null;
    return collectionItemId(id, focus.key, config.role === 'listbox' ? undefined : focus.column);
  }
  function aria() {
    const target = focusId();
    if (target && document.getElementById(target) && element.contains(document.getElementById(target)))
      element.setAttribute('aria-activedescendant', target);
    else element.removeAttribute('aria-activedescendant');
    element.setAttribute('aria-busy', String(!!interaction.state().pending || config.loading === true));
  }
  function refresh() {
    if (disposed) return;
    if (frame !== null) { cancelFrame(frame); frame = null; }
    element.setAttribute('role', config.role ?? 'grid');
    element.setAttribute('aria-label', config.label ?? 'Collection');
    element.setAttribute('aria-multiselectable', 'true');
    element.setAttribute('dir', config.direction ?? 'ltr');
    if (config.role !== 'listbox') {
      element.setAttribute('aria-rowcount', String(config.totalKnown === false ? -1 : config.count));
      element.setAttribute('aria-colcount', String(config.columnCount ?? 1));
    }
    else { element.removeAttribute('aria-rowcount'); element.removeAttribute('aria-colcount'); }
    const left = logicalScrollOffset(element.scrollLeft, Math.max(0, controller.columnAxis.extent() - element.clientWidth),
      config.direction === 'rtl' ? 'negative' : 'ltr');
    controller.viewport({ top: element.scrollTop, left, width: element.clientWidth, height: element.clientHeight });
    if (measurePending) { measurePending = false; measureVisible(); }
    interaction.update({ ...controller.options(), pageRows: Math.max(1, Math.floor(element.clientHeight / controller.options().rowSize)) });
    const focus = interaction.state().focus;
    const result = focus && config.keyAt(focus.index) === focus.key ? controller.pin([focus.index], [focus.column]) : controller.pin();
    // Remove the old ID before keyed removal; expose a new descendant only after realization.
    element.removeAttribute('aria-activedescendant');
    render(controller.view(interaction, id));
    element.setAttribute('data-state', result.state);
    if (result.reason) element.setAttribute('data-reason', result.reason); else element.removeAttribute('data-reason');
    aria();
    if (config.measured) {
      const rows = [...element.querySelectorAll('.jc-content')];
      const live = new Set(rows);
      for (const [node, stop] of observed) if (!live.has(node)) { stop(); observed.delete(node); }
      for (const row of rows) if (!observed.has(row)) observed.set(row, observe(row, scheduleMeasure));
    }
    config.onChange?.({ state: result.state, ...(result.reason ? {reason: result.reason} : {}), ...controller.stats(), focus: interaction.state().focus });
  }
  function scheduleMeasure() { measurePending = true; schedule(); }
  function measureVisible() {
    if (disposed || !config.measured) return;
    let changed = false;
    const rows = [...element.querySelectorAll('.jc-row')];
    if (measurementCursor >= rows.length) measurementCursor = 0;
    const end = Math.min(rows.length, measurementCursor + config.maxMeasurementWork);
    for (let cursor = measurementCursor; cursor < end; cursor++) {
      const row = rows[cursor];
      const index = Number(row.getAttribute('data-row')), key = config.keyAt(index);
      if (key == null) continue;
      const height = config.measureRow ? config.measureRow(row, index) : Math.max(1,
        ...[...row.querySelectorAll('.jc-content')].map((content) => content.getBoundingClientRect().height + 16));
      if (Number.isFinite(height) && height > 0 && Math.abs(height - controller.rowAxis.size(index)) > 0.5) {
        const result = controller.measure(index, key, height);
        if (result.state === 'ready') { element.scrollTop = result.offset; changed = true; }
      }
    }
    measurementCursor = end < rows.length ? end : 0;
    if (measurementCursor) { measurePending = true; schedule(); }
    else if (changed) schedule();
  }
  function applyScroll(result) {
    if (result.state === 'ready') {
      element.scrollTop = result.offset;
      element.scrollLeft = (config.direction === 'rtl' ? -1 : 1) * (result.left ?? controller.position().left);
      refresh();
    }
    return result;
  }
  function editing(target) { return target !== element && !!target?.closest?.('input,textarea,select,[contenteditable="true"]'); }
  function keydown(event) {
    const result = interaction.key({ key: event.key, shiftKey: event.shiftKey, ctrlKey: event.ctrlKey,
      altKey: event.altKey, metaKey: event.metaKey, isComposing: composing || event.isComposing, editing: editing(event.target) });
    if (result.state === 'ignored') return;
    event.preventDefault();
    if (result.state === 'loading') { config.onRealize?.(result.index, result.column); aria(); }
    else if (result.state === 'activate') config.onActivate?.(result);
    else if (result.state === 'return-focus') config.returnFocus?.focus();
    else if (result.index !== undefined) applyScroll(controller.scrollToIndex(result.index, result.column));
    else refresh();
    config.onIntent?.(interaction.state().selection);
  }
  function focusin(event) {
    const row = event.target.closest?.('.jc-row');
    if (row) {
      const column = event.target.closest?.('.jc-cell');
      interaction.focusIndex(Number(row.getAttribute('data-row')), Number(column?.getAttribute('data-column') ?? 0));
      aria();
    }
    else if (!interaction.state().focus) { interaction.focusIndex(controller.rowAxis.indexAt(element.scrollTop)); refresh(); }
  }
  function click(event) {
    if (editing(event.target)) return;
    const row = event.target.closest?.('.jc-row');
    if (!row) return;
    const column = event.target.closest?.('.jc-cell');
    const result = interaction.focusIndex(Number(row.getAttribute('data-row')), Number(column?.getAttribute('data-column') ?? 0));
    if (result.state === 'ready') interaction.toggle(result.key);
    element.focus(); refresh(); config.onIntent?.(interaction.state().selection);
  }
  const listeners = { scroll: schedule, keydown, focusin, click,
    compositionstart: () => { composing = true; }, compositionend: () => { composing = false; } };
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const [name, listener] of Object.entries(listeners)) element.removeEventListener(name, listener);
    if (frame !== null) cancelFrame(frame);
    frame = null;
    let failure, failed = false;
    const clean = (fn) => { try { fn(); } catch (error) { if (!failed) { failure = error; failed = true; } } };
    if (unobserve) clean(unobserve);
    for (const stop of observed.values()) clean(stop);
    observed.clear(); clean(() => render.destroy()); clean(() => controller.dispose()); clean(() => element.remove());
    if (failed) throw failure;
  }
  try {
    host.appendChild(element);
    for (const [name, listener] of Object.entries(listeners)) element.addEventListener(name, listener, { passive: name === 'scroll' });
    unobserve = observe(element, schedule); refresh();
  }
  catch (error) { dispose(); throw error; }
  return {
    controller, interaction, element, refresh, measureVisible,
    update(next) {
      config = { ...config, ...next }; controller.update(next); interaction.update(next);
      element.scrollTop = controller.position().top; refresh();
    },
    scrollToOffset(offset) { return applyScroll(controller.scrollToOffset(offset)); },
    /** @param {number} index @param {number} [column] */
    scrollToIndex(index, column) { return applyScroll(controller.scrollToIndex(index, column)); },
    scrollToKey(key) { return applyScroll(controller.scrollToKey(key)); },
    restore(intent) {
      if (intent?.selection) interaction.restore(intent.selection);
      return applyScroll(controller.restore(intent?.anchor));
    },
    snapshot() { return { anchor: controller.snapshot(), selection: interaction.state().selection }; },
    stats() { return { ...controller.stats(), listeners: disposed ? 0 : Object.keys(listeners).length,
      observers: disposed ? 0 : 1 + observed.size, frames: frame === null ? 0 : 1 }; },
    dispose,
  };
}

/** Adapt controller disposal to the existing WidgetDef unmount lifecycle.
 * @param {any | ((props:any, emit:any)=>any)} options */
export function createCollectionWidget(options) {
  const config = (props, emit) => typeof options === 'function' ? options(props, emit) : { ...options, ...props };
  return {
    mount(host, props, emit) { return { mounted: mountCollection(host, config(props, emit)), emit }; },
    update(handle, props) { handle.mounted.update(config(props, handle.emit)); },
    unmount(handle) { handle.mounted.dispose(); },
  };
}

/** Mount the same controller over an injected app coordinator. It owns the coordinator lifetime.
 * @param {HTMLElement} host @param {any} coordinator @param {any} options */
export function mountProviderCollection(host, coordinator, options) {
  let disposed = false, loading = false, mounted, stop;
  const config = () => {
    const state = coordinator.observation();
    return { count: coordinator.logicalCount(), totalKnown: state.total.kind === 'known', loading: state.state === 'loading',
      query: state.query, snapshot: state.snapshot, keyAt: (index) => coordinator.keyAt(index),
      getItem: (index) => coordinator.rowAt(index), indexOf: (key) => coordinator.indexOf(key) };
  };
  async function loadVisible() {
    if (disposed || loading || !mounted) return;
    const range = mounted.controller.layout().rowRange;
    if (!range || range.start === range.end) return;
    let start = range.start;
    while (start < range.end && coordinator.keyAt(start) != null) start++;
    if (start === range.end) return;
    loading = true;
    try {
      const result = await coordinator.requestRange({ start, end: range.end });
      if (!disposed) { mounted.element.setAttribute('data-provider-state', result.state);
        if (result.reason) mounted.element.setAttribute('data-provider-reason', result.reason); }
    }
    finally { loading = false; }
  }
  mounted = mountCollection(host, { ...options, ...config(),
    onChange: (state) => {
      const focused = mounted?.element.ownerDocument.activeElement;
      const editing = focused && focused !== mounted?.element && mounted?.element.contains(focused);
      coordinator.pinKeys(editing && state.focus ? [state.focus.key] : []);
      options.onChange?.(state); queueMicrotask(loadVisible);
    },
    onRealize: async (index) => {
      const result = await coordinator.requestRange({start:index,end:index+1});
      if (!disposed && result.state === 'ready') { mounted.update(config()); mounted.scrollToIndex(index); }
      else if (!disposed) { mounted.interaction.cancelPending(); mounted.element.setAttribute('data-provider-reason', result.reason ?? result.state); mounted.refresh(); }
    } });
  stop = coordinator.subscribe(() => { if (!disposed) mounted.update(config()); });
  queueMicrotask(loadVisible);
  return {
    mounted, coordinator,
    async next() { const result = await coordinator.next(); if (!disposed && result.state === 'ready') mounted.scrollToIndex(result.start); return result; },
    output(sink, options = {}) { return coordinator.output(sink, { selection: mounted.interaction.state().selection, ...options }); },
    print(sink, options = {}) { return coordinator.output(sink, { selection: mounted.interaction.state().selection, ...options }); },
    snapshot() { return mounted.snapshot(); },
    async dispose() { if (!disposed) { disposed = true; stop(); mounted.dispose(); } await coordinator.dispose(); },
  };
}
