//@ts-check
import { createDragInteraction } from '../drag.js';
import { mountCollection } from './index.js';

/** @typedef {import('../drag.js').DragTarget} DragTarget */
/** @typedef {{id:string, mounted:ReturnType<typeof mountCollection>,
 * columnKey:(index:number)=>string, indexOfColumn:(key:string)=>number}} DragContainer */
/** @typedef {import('../drag.js').DragOptions & {
 * locateSource:(key:string)=>DragTarget|null, disabled?:(target:DragTarget)=>boolean,
 * label?:(key:string)=>string, portal?:HTMLElement, maxContainers?:number,
 * edgeSize?:number, maxScrollPerFrame?:number,
 * requestFrame?:(fn:FrameRequestCallback)=>number, cancelFrame?:(id:number)=>void
 * }} CollectionDragOptions */

/** Own sensors and an overlay across bounded, already-mounted collections.
 * Touch starts only on handles marked data-jc-drag and styled touch-action:none.
 * @param {DragContainer[]} containers @param {CollectionDragOptions} options */
export function mountCollectionDrag(containers, options) {
  const maxContainers = options.maxContainers ?? 8;
  const edge = options.edgeSize ?? 32, speed = options.maxScrollPerFrame ?? 16;
  if (!Number.isSafeInteger(maxContainers) || maxContainers < 1 || !containers.length || containers.length > maxContainers
    || !Number.isFinite(edge) || edge <= 0 || !Number.isFinite(speed) || speed <= 0)
    throw new RangeError('Invalid drag container or scroll credits');
  const byId = new Map(containers.map((container) => [container.id, container]));
  if (byId.size !== containers.length || containers.some((c) => typeof c.id !== 'string'
    || typeof c.columnKey !== 'function' || typeof c.indexOfColumn !== 'function')) throw new TypeError('Drag containers need unique stable identities and column lookups');
  const document = containers[0].mounted.element.ownerDocument, window = document.defaultView;
  if (containers.some((c) => c.mounted.element.ownerDocument !== document)) throw new TypeError('Drag containers must share a document');
  const portal = options.portal ?? document.documentElement;
  const requestFrame = options.requestFrame ?? ((fn) => window.requestAnimationFrame(fn));
  const cancelFrame = options.cancelFrame ?? ((id) => window.cancelAnimationFrame(id));
  let disposed = false, frame = null, overlay = null, pointer = null, retained = null, focusBefore = null;
  let lastPoint = null, copy = false, suppressedClick = null, announcement = '';
  const stops = [];
  const status = document.createElement('div');
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.setAttribute('aria-atomic', 'true');
  Object.assign(status.style, { position: 'fixed', width: '1px', height: '1px', overflow: 'hidden', clipPath: 'inset(50%)' });
  function location(target) {
    const container = byId.get(target?.container);
    if (!container || !container.mounted.element.isConnected) return null;
    const config = container.mounted.controller.options();
    const row = config.indexOf?.(target.key) ?? container.mounted.controller.layout().rows.find((r) => r.key === target.key)?.index;
    const column = container.indexOfColumn(target.column);
    if (!Number.isSafeInteger(row) || row < 0 || config.keyAt(row) !== target.key
      || !Number.isSafeInteger(column) || column < 0 || column >= config.columnCount || container.columnKey(column) !== target.column) return null;
    const cell = container.mounted.element.querySelector(`[data-row="${row}"] [data-column="${column}"]`);
    return { container, row, column, cell };
  }
  const available = (target) => {
    const found = location(target);
    return !!found?.cell && !options.disabled?.(target) && (options.validTarget?.(target) ?? true);
  };
  const editing = (target) => !!target?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])');
  function cleanGesture() {
    let failure;
    const clean = (fn) => { try { fn(); } catch (error) { failure ??= error; } };
    if (frame !== null) clean(() => cancelFrame(frame));
    frame = null;
    const capture = pointer; pointer = null;
    clean(() => { if (capture?.element.hasPointerCapture?.(capture.id)) capture.element.releasePointerCapture(capture.id); });
    const release = retained; retained = null; if (release) clean(release);
    const priorOverlay = overlay; overlay = null; clean(() => priorOverlay?.remove());
    if (focusBefore) {
      const target = focusBefore; focusBefore = null;
      clean(() => {
        if (target.isConnected) target.focus({ preventScroll: true });
        else containers.find((c) => c.mounted.element.isConnected)?.mounted.element.focus({ preventScroll: true });
      });
    }
    if (failure) throw failure;
  }
  function changed(state) {
    const active = ['dragging', 'validating', 'committing'].includes(state.phase);
    if (active) {
      if (!overlay) {
        overlay = document.createElement('div'); overlay.setAttribute('data-jc-overlay', '');
        overlay.setAttribute('aria-hidden', 'true');
        Object.assign(overlay.style, { position: 'fixed', margin: '0', inset: 'auto', pointerEvents: 'none',
          zIndex: '2147483647', padding: '8px', background: 'Canvas', color: 'CanvasText', border: '1px solid currentColor' });
        portal.appendChild(overlay);
        if (typeof overlay.showPopover === 'function') { overlay.setAttribute('popover', 'manual'); overlay.showPopover(); }
      }
      overlay.textContent = `${state.mode === 'copy' ? 'Copy' : 'Move'} ${options.label?.(state.source.key) ?? state.source.key}`;
      overlay.style.left = `${state.point.x + 12}px`; overlay.style.top = `${state.point.y + 12}px`;
    }
    if (!['armed', 'dragging', 'validating', 'committing'].includes(state.phase)) cleanGesture();
    if (!['armed', 'dragging'].includes(state.phase) && frame !== null) { cancelFrame(frame); frame = null; }
    const message = state.phase === 'dragging' ? `${state.mode === 'copy' ? 'Copying' : 'Moving'} ${state.source.key}${state.target ? ` to ${state.target.key}, ${state.target.column}` : ''}. Enter to drop, Escape to cancel.`
      : state.phase === 'settled' ? 'Drop accepted.' : state.phase === 'cancelled' ? `Drag cancelled: ${state.reason}.`
        : state.phase === 'validating' || state.phase === 'committing' ? 'Checking drop.' : '';
    if (message !== announcement) { announcement = message; status.textContent = message; }
    options.onChange?.(state);
  }
  const interaction = createDragInteraction({ activationDistance: options.activationDistance,
    resolveSource: (key) => options.resolveSource(key), validTarget: available,
    validate: (intent, context) => options.validate?.(intent, context) ?? true,
    commit: (intent, context) => options.commit(intent, context), onChange: changed });
  function hit(point) {
    const elements = document.elementsFromPoint(point.x, point.y).slice(0, 64);
    for (const element of elements) {
      const cell = element.closest?.('.jc-cell'), row = cell?.closest('.jc-row');
      if (!cell || !row) continue;
      const container = containers.find((c) => c.mounted.element.contains(cell));
      if (!container) continue;
      const key = row.getAttribute('data-key'), column = container.columnKey(Number(cell.getAttribute('data-column')));
      if (typeof key !== 'string' || typeof column !== 'string') continue;
      const target = { container: container.id, key, column };
      return available(target) ? target : null;
    }
    return null;
  }
  function scroll(point) {
    const container = containers.find((c) => {
      const r = c.mounted.element.getBoundingClientRect();
      return point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom;
    });
    let node = container?.mounted.element, xDone = false, yDone = false, moved = false;
    for (let i = 0; node && i < 8; i++, node = node.parentElement) {
      const r = node.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const delta = (v, low, high) => v < low + edge ? -speed : v > high - edge ? speed : 0;
      const left = node.scrollLeft, top = node.scrollTop;
      const maxX = Math.max(0, node.scrollWidth - node.clientWidth), maxY = Math.max(0, node.scrollHeight - node.clientHeight);
      const style = window.getComputedStyle(node), rtl = style.direction === 'rtl';
      const root = node === document.scrollingElement;
      if (!xDone && maxX && (root || /auto|scroll/.test(style.overflowX))) node.scrollLeft = Math.max(rtl ? -maxX : 0, Math.min(rtl ? 0 : maxX,
        left + delta(point.x, r.left, r.right) / Math.max(0.01, r.width / node.offsetWidth)));
      if (!yDone && maxY && (root || /auto|scroll/.test(style.overflowY))) node.scrollTop = Math.max(0, Math.min(maxY,
        top + delta(point.y, r.top, r.bottom) / Math.max(0.01, r.height / node.offsetHeight)));
      xDone ||= node.scrollLeft !== left; yDone ||= node.scrollTop !== top;
      moved ||= xDone || yDone;
    }
    if (moved) container?.mounted.refresh();
  }
  function tick() {
    frame = null;
    if (disposed || !['armed', 'dragging'].includes(interaction.revalidate().phase)) return;
    if (!location(options.locateSource(interaction.state().source.key))?.cell) { interaction.cancel('source-unavailable'); return; }
    if (lastPoint && interaction.state().input !== 'keyboard') {
      if (interaction.state().phase === 'dragging') {
        interaction.move(lastPoint, null, copy);
        scroll(lastPoint);
      }
      interaction.move(lastPoint, hit(lastPoint), copy);
    }
    if (['armed', 'dragging'].includes(interaction.state().phase)) frame = requestFrame(tick);
  }
  function start(key, input, point, copyMode) {
    const current = interaction.state();
    if (current.pending || ['armed', 'dragging'].includes(current.phase)) return false;
    const origin = options.locateSource(key), place = location(origin);
    if (!place?.cell) return false;
    focusBefore = document.activeElement; lastPoint = point; copy = copyMode;
    try {
      const started = interaction.begin(key, { input, point, copy: copyMode });
      if (!['armed', 'dragging'].includes(started.phase)) { focusBefore = null; return false; }
      retained = place.container.mounted.retain(() => {
        const current = location(options.locateSource(key));
        return current ? { rows: [current.row], columns: [current.column] } : { rows: [], columns: [] };
      });
      place.container.mounted.refresh();
      if (!['armed', 'dragging'].includes(interaction.state().phase)) return false;
      if (input === 'keyboard') interaction.move(point, origin, copyMode);
      frame = requestFrame(tick); return true;
    }
    catch (error) {
      try { interaction.cancel('activation-failed'); } finally { cleanGesture(); }
      throw error;
    }
  }
  function pointerdown(event) {
    suppressedClick = null;
    if (disposed || pointer || event.button !== 0 || !event.isPrimary || editing(event.target)) return;
    const handle = event.target.closest?.('[data-jc-drag]');
    if (!handle || !containers.some((c) => c.mounted.element.contains(handle))) return;
    if (event.pointerType === 'touch' && window.getComputedStyle(handle).touchAction !== 'none') return;
    if (start(handle.getAttribute('data-jc-drag'), event.pointerType === 'touch' ? 'touch' : 'pointer', { x: event.clientX, y: event.clientY }, event.altKey)) {
      pointer = { id: event.pointerId, element: handle };
      try { handle.setPointerCapture(event.pointerId); }
      catch (error) { interaction.cancel('capture-failed'); throw error; }
      if (event.pointerType === 'touch') event.preventDefault();
    }
  }
  function pointermove(event) {
    if (!pointer || pointer.id !== event.pointerId) return;
    lastPoint = { x: event.clientX, y: event.clientY }; copy = event.altKey;
    const next = interaction.move(lastPoint, hit(lastPoint), copy);
    if (next.phase === 'dragging') event.preventDefault();
  }
  function pointerup(event) {
    if (!pointer || pointer.id !== event.pointerId) return;
    if (interaction.state().phase === 'dragging') {
      event.preventDefault(); suppressedClick = { id: pointer.id, until: Date.now() + 300 };
      const held = pointer; pointer = null;
      if (held.element.hasPointerCapture(held.id)) held.element.releasePointerCapture(held.id);
      void interaction.drop();
    }
    else interaction.cancel('not-activated');
  }
  function keydown(event) {
    if (event.isComposing) return;
    const current = interaction.state();
    if (['armed', 'dragging', 'validating', 'committing'].includes(current.phase) && event.key === 'Escape') {
      event.preventDefault(); event.stopImmediatePropagation(); interaction.cancel('escape'); return;
    }
    if (editing(event.target)) return;
    if (['armed', 'dragging', 'validating', 'committing'].includes(current.phase)) {
      if (event.key === 'Alt' && current.phase === 'dragging') {
        copy = event.altKey; interaction.move(current.point, current.target, copy); return;
      }
      if (current.input !== 'keyboard' || current.phase !== 'dragging') return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault(); event.stopImmediatePropagation(); void interaction.drop(); return;
      }
      const place = location(current.target ?? options.locateSource(current.source.key));
      if (!place || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Alt'].includes(event.key)) return;
      event.preventDefault(); event.stopImmediatePropagation();
      let container = place.container, row = place.row, column = place.column;
      if (event.key === 'ArrowUp') row--;
      if (event.key === 'ArrowDown') row++;
      const direction = container.mounted.controller.options().direction === 'rtl' ? -1 : 1;
      if (event.key === 'ArrowLeft') column -= direction;
      if (event.key === 'ArrowRight') column += direction;
      if (event.key === 'Tab') container = containers[(containers.indexOf(container) + (event.shiftKey ? containers.length - 1 : 1)) % containers.length];
      const config = container.mounted.controller.options();
      row = Math.max(0, Math.min(config.count - 1, row)); column = Math.max(0, Math.min(config.columnCount - 1, column));
      container.mounted.scrollToIndex(row, column);
      const target = { container: container.id, key: config.keyAt(row), column: container.columnKey(column) };
      const rect = location(target)?.cell?.getBoundingClientRect();
      if (rect) interaction.move({ x: rect.left, y: rect.top }, target, event.altKey);
      return;
    }
    if (![' ', 'Enter'].includes(event.key)) return;
    const handle = event.target.closest?.('[data-jc-drag]');
    if (!handle || !containers.some((c) => c.mounted.element.contains(handle))) return;
    const rect = handle.getBoundingClientRect();
    if (start(handle.getAttribute('data-jc-drag'), 'keyboard', { x: rect.left, y: rect.top }, event.altKey)) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }
  const listen = (node, name, fn, config = true) => {
    node.addEventListener(name, fn, config); stops.push(() => node.removeEventListener(name, fn, config));
  };
  function dispose() {
    if (disposed) return;
    disposed = true;
    let failure;
    const clean = (fn) => { try { fn(); } catch (error) { failure ??= error; } };
    clean(() => interaction.dispose()); clean(cleanGesture);
    for (const stop of stops.splice(0)) clean(stop);
    clean(() => status.remove());
    if (failure) throw failure;
  }
  try {
    portal.appendChild(status);
    listen(window, 'pointerdown', pointerdown);
    listen(window, 'pointermove', pointermove, { capture: true, passive: false });
    listen(window, 'pointerup', pointerup);
    listen(window, 'pointercancel', (event) => { if (pointer?.id === event.pointerId) interaction.cancel('pointer-cancel'); });
    listen(window, 'lostpointercapture', (event) => {
      if (pointer?.id === event.pointerId && !pointer.element.hasPointerCapture(pointer.id)) interaction.cancel('capture-lost');
    });
    listen(window, 'blur', (event) => { if (event.target === window) interaction.cancel('blur'); });
    listen(window, 'keydown', keydown);
    listen(window, 'keyup', (event) => { if (event.key === 'Alt' && interaction.state().phase === 'dragging') {
      const current = interaction.state(); copy = false; interaction.move(current.point, current.target, false);
    } });
    listen(window, 'click', (event) => {
      if (suppressedClick && event.pointerId === suppressedClick.id && Date.now() < suppressedClick.until) {
        suppressedClick = null; event.preventDefault(); event.stopImmediatePropagation();
      }
    });
    for (const container of containers) stops.push(container.mounted.subscribe((event) => {
      if (event.kind === 'dispose') { dispose(); return; }
      if (event.kind === 'reset') interaction.cancel('source-reset');
      else if (event.state !== 'ready') interaction.cancel(event.reason ?? 'collection-unavailable');
      else if (interaction.state().phase !== 'committing') {
        interaction.revalidate();
        // A keyed DOM move can release capture while preserving the source.
        // Reacquire only for the same connected handle and live pointer.
        if (pointer?.element.isConnected && !pointer.element.hasPointerCapture(pointer.id)) pointer.element.setPointerCapture(pointer.id);
      }
    }));
  }
  catch (error) { dispose(); throw error; }
  return { interaction, dispose, cancel: (reason = 'cancelled') => interaction.cancel(reason),
    /** Update authority callbacks; geometry and resource owners belong to this mount.
     * @param {Partial<CollectionDragOptions>} next */
    update(next) { options = { ...options, ...next }; return interaction.revalidate(); },
    stats: () => ({ listeners: disposed ? 0 : 9, subscriptions: disposed ? 0 : containers.length,
      frames: frame === null ? 0 : 1, overlays: overlay ? 1 : 0, statusNodes: disposed ? 0 : 1,
      pending: interaction.state().pending ? 1 : 0 }) };
}

/** One collection and its interaction share the existing WidgetDef lifetime.
 * @param {any|((props:any,emit:any)=>any)} options */
export function createDraggableCollectionWidget(options) {
  const config = (props, emit) => typeof options === 'function' ? options(props, emit) : { ...options, ...props };
  return {
    mount(host, props, emit) {
      const settings = config(props, emit), mounted = mountCollection(host, settings.collection);
      try {
        const container = { id: settings.id, mounted, columnKey: settings.columnKey, indexOfColumn: settings.indexOfColumn };
        const drag = mountCollectionDrag([container], settings.drag);
        return { mounted, drag, container, emit };
      }
      catch (error) { mounted.dispose(); throw error; }
    },
    update(handle, props) {
      const settings = config(props, handle.emit);
      if (settings.id !== handle.container.id) throw new TypeError('A different drag container requires a new widget key');
      handle.container.columnKey = settings.columnKey; handle.container.indexOfColumn = settings.indexOfColumn;
      handle.drag.update(settings.drag); handle.mounted.update(settings.collection);
    },
    unmount(handle) { try { handle.drag.dispose(); } finally { handle.mounted.dispose(); } },
  };
}
