//@ts-check
/**
 * @file A reusable drag-splitter widget for a two-pane (or rail|editor|stage)
 * grid. It drives a CSS ratio variable LIVE during a drag — no per-move
 * dispatch, which would flood the transaction log and undo — and commits the
 * ratio on pointer-UP only, plus keyboard resize as an ARIA separator. Every
 * DOM call is guarded so it mounts inertly over a headless stub (there the
 * live drag is browser-verified). The host binds it as a widget and
 * parameterizes the grid/rail selectors, the CSS variable and the commit
 * action. Widget props `{ ratio, axis: 'x' | 'y' }` select the live direction;
 * the axis defaults to x. The ratio's `-first`/`-rest` CSS variables carry
 * fractional tracks for stacked grids after their fixed toolbar and gaps.
 */

/**
 * @param {Object} opts
 * @param {string} opts.action - the app action dispatched with the committed ratio
 * @param {string} [opts.grid='.jstudio'] - selector for the grid element (the host's closest ancestor)
 * @param {string} [opts.rail] - selector for a fixed left rail inside the grid; the ratio
 *   spans from the rail's right edge (or the grid's left when absent) to the grid's right
 * @param {string} [opts.cssVar='--js-ratio'] - the CSS custom property the grid reads for the split
 * @param {number} [opts.min=0.1] - the smallest left-pane ratio (also Home)
 * @param {number} [opts.max=0.9] - the largest left-pane ratio (also End)
 * @param {number} [opts.step=0.05] - the arrow-key step
 * @param {number} [opts.fineStep=0.01] - the Shift+arrow step
 * @returns {{ mount: Function, update: Function, unmount: Function }}
 */
export function createSplitterWidget(opts) {
  const action = opts.action;
  const gridSel = opts.grid ?? '.jstudio';
  const railSel = opts.rail ?? null;
  const cssVar = opts.cssVar ?? '--js-ratio';
  const min = opts.min ?? 0.1;
  const max = opts.max ?? 0.9;
  const step = opts.step ?? 0.05;
  const fineStep = opts.fineStep ?? 0.01;
  const clamp = (r) => Math.min(max, Math.max(min, r));

  return {
    mount(host, props, emit) {
      // pointermove/up ride the OWNER DOCUMENT for the span of a drag — the
      // robust splitter pattern: the pointer leaves the thin handle at once,
      // so listening on the handle alone (even with capture) drops the drag.
      // Document listeners catch the move everywhere, torn off on pointer-up.
      const doc = host.ownerDocument ?? null;
      const gridOf = () => (typeof host.closest === 'function' ? host.closest(gridSel) : null);
      const applyRatio = (r) => {
        gridOf()?.style?.setProperty?.(cssVar, String(r));
        gridOf()?.style?.setProperty?.(cssVar + '-first', `${r}fr`);
        gridOf()?.style?.setProperty?.(cssVar + '-rest', `${1 - r}fr`);
        host.setAttribute?.('aria-valuenow', String(Math.round(r * 100)));
        host.setAttribute?.('aria-orientation', handle.axis === 'y' ? 'horizontal' : 'vertical');
      };
      // A rail spans the content rows, so its top excludes the toolbar
      // when the same content is stacked vertically.
      const ratioAt = (clientX, clientY) => {
        const g = gridOf();
        if (g === null) return handle.ratio;
        const rail = railSel !== null && typeof g.querySelector === 'function' ? g.querySelector(railSel) : null;
        const box = g.getBoundingClientRect();
        const railBox = rail?.getBoundingClientRect();
        const vertical = handle.axis === 'y';
        const start = vertical ? (railBox?.top ?? box.top) : (railBox?.right ?? box.left);
        const end = vertical ? (railBox?.bottom ?? box.bottom) : box.right;
        const point = vertical ? clientY : clientX;
        if (!(end > start) || !Number.isFinite(point)) return handle.ratio;
        return clamp((point - start) / (end - start));
      };
      const onMove = (e) => {
        if (!handle.dragging) return;
        e.preventDefault?.();
        handle.ratio = ratioAt(e.clientX, e.clientY);
        applyRatio(handle.ratio); // live only — the commit is on pointer-up
      };
      const onUp = () => {
        if (!handle.dragging) return;
        handle.dragging = false;
        doc?.removeEventListener?.('pointermove', onMove);
        doc?.removeEventListener?.('pointerup', onUp);
        doc?.removeEventListener?.('pointercancel', onCancel);
        emit({ action, with: handle.ratio });
      };
      const onCancel = () => {
        if (!handle.dragging) return;
        handle.dragging = false;
        handle.ratio = handle.startRatio;
        applyRatio(handle.ratio);
        doc?.removeEventListener?.('pointermove', onMove);
        doc?.removeEventListener?.('pointerup', onUp);
        doc?.removeEventListener?.('pointercancel', onCancel);
      };
      const onDown = (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        handle.dragging = true;
        handle.startRatio = handle.ratio;
        e.preventDefault?.();
        doc?.addEventListener?.('pointermove', onMove);
        doc?.addEventListener?.('pointerup', onUp);
        doc?.addEventListener?.('pointercancel', onCancel);
      };
      const onKey = (e) => {
        const s = e.shiftKey ? fineStep : step;
        let next = null;
        if (e.key === 'ArrowLeft' || e.key === (handle.axis === 'y' ? 'ArrowUp' : 'ArrowDown')) next = clamp(handle.ratio - s);
        else if (e.key === 'ArrowRight' || e.key === (handle.axis === 'y' ? 'ArrowDown' : 'ArrowUp')) next = clamp(handle.ratio + s);
        else if (e.key === 'Home') next = min;
        else if (e.key === 'End') next = max;
        if (next === null) return;
        e.preventDefault?.();
        handle.ratio = next;
        applyRatio(next);
        emit({ action, with: next });
      };

      const handle = { host, doc, ratio: clamp(Number(props?.ratio ?? 0.5)),
        axis: props?.axis === 'y' ? 'y' : 'x', startRatio: 0.5,
        dragging: false, applyRatio, onMove, onUp, onCancel };
      applyRatio(handle.ratio);
      host.addEventListener?.('pointerdown', onDown);
      host.addEventListener?.('keydown', onKey);
      handle.hostListeners = [['pointerdown', onDown], ['keydown', onKey]];
      return handle;
    },
    update(handle, props) {
      const axis = props?.axis === 'y' ? 'y' : 'x';
      if (axis !== handle.axis) {
        handle.onCancel();
        handle.axis = axis;
        handle.applyRatio(handle.ratio);
      }
      const r = clamp(Number(props?.ratio ?? 0.5));
      if (r !== handle.ratio && !handle.dragging) {
        handle.ratio = r;
        handle.applyRatio(r);
      }
    },
    unmount(handle) {
      for (const [type, fn] of handle.hostListeners) handle.host.removeEventListener?.(type, fn);
      handle.doc?.removeEventListener?.('pointermove', handle.onMove);
      handle.doc?.removeEventListener?.('pointerup', handle.onUp);
      handle.doc?.removeEventListener?.('pointercancel', handle.onCancel);
    },
  };
}
