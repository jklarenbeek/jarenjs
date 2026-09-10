//@ts-check
import { isJsonValue } from '@jarenjs/core/object';
/** Identity-based interaction. Range intent stores endpoint keys in a declared query/snapshot. */

/** @param {any} options */
export function createCollectionInteraction(options) {
  let config = { columnCount: 1, pageRows: 10, query: '', snapshot: '', maxSelectedKeys: 4096, ...options };
  let focus = null, pending = null, rangeAnchor = null;
  let selection = { mode: 'keys', keys: [], ranges: [], exclusions: [], query: config.query, snapshot: config.snapshot };
  function state() { return structuredClone({ focus, pending, selection }); }
  function focusIndex(index, column = 0) {
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(column)) return {state:'error',reason:'invalid-index'};
    if (!config.count) { focus = null; pending = null; return { state: 'ready', focus: null }; }
    index = Math.max(0, Math.min(config.count - 1, index));
    column = Math.max(0, Math.min(config.columnCount - 1, column));
    const key = config.keyAt(index);
    if (typeof key !== 'string') { pending = { index, column }; return { state: 'loading', index, column }; }
    focus = { key, index, column }; pending = null;
    return { state: 'ready', ...focus };
  }
  function scoped() { return selection.query === config.query && selection.snapshot === config.snapshot; }
  function selected(key) {
    if (key == null) return false;
    if (selection.mode === 'all' && scoped()) return !selection.exclusions.includes(key);
    if (selection.keys.includes(key)) return true;
    if (!scoped()) return false;
    return selection.ranges.some((range) => {
      if (key === range.fromKey || key === range.toKey) return true;
      const index = config.indexOf?.(key), start = config.indexOf?.(range.fromKey), end = config.indexOf?.(range.toKey);
      return index >= 0 && start >= 0 && end >= 0 && index >= Math.min(start, end) && index <= Math.max(start, end);
    });
  }
  function toggle(key) {
    if (typeof key !== 'string') return {state:'error',reason:'invalid-selection'};
    if (selection.mode === 'all' && scoped()) {
      const excluded = selection.exclusions.includes(key);
      if (!excluded && selection.exclusions.length >= config.maxSelectedKeys) return { state: 'budget-exhausted', reason: 'selection-credits' };
      selection.exclusions = excluded ? selection.exclusions.filter((item) => item !== key) : [...selection.exclusions, key];
    }
    else {
      const exists = selection.keys.includes(key);
      if (!exists && selection.keys.length >= config.maxSelectedKeys) return { state: 'budget-exhausted', reason: 'selection-credits' };
      selection.keys = exists ? selection.keys.filter((item) => item !== key) : [...selection.keys, key];
    }
    return { state: 'ready' };
  }
  return {
    state, selected, focusIndex,
    cancelPending() { pending = null; },
    update(next) {
      config = { ...config, ...next };
      if (pending) {
        const intent = pending;
        if (intent.query !== undefined && (intent.query !== config.query || intent.snapshot !== config.snapshot)) { pending = null; return {state:'invalidated'}; }
        const result = focusIndex(intent.index, intent.column);
        if (result.state === 'ready' && intent.fromKey) selection = {mode:'keys',keys:[],exclusions:[],
          ranges:[{fromKey:intent.fromKey,toKey:focus.key}],query:config.query,snapshot:config.snapshot};
        else if (pending) pending = {...pending,...intent};
        return result;
      }
      if (focus) {
        const index = config.indexOf?.(focus.key);
        if (index >= 0) focus = { ...focus, index };
        else if (next.removedKeys?.includes(focus.key) || config.count === 0) return focusIndex(focus.index, focus.column);
      }
      return { state: 'ready' };
    },
    toggle,
    selectAll() { selection = { mode: 'all', keys: [], ranges: [], exclusions: [], query: config.query, snapshot: config.snapshot }; },
    clear() { selection = { mode: 'keys', keys: [], ranges: [], exclusions: [], query: config.query, snapshot: config.snapshot }; },
    restore(intent) {
      // Only JSON intent returns from navigation; loaded resources never travel here.
      if (!intent || !isJsonValue(intent) || typeof intent.query !== 'string' || typeof intent.snapshot !== 'string' || !['keys', 'all'].includes(intent.mode) || !Array.isArray(intent.keys) || !Array.isArray(intent.exclusions)
        || !Array.isArray(intent.ranges) || intent.keys.length + intent.exclusions.length > config.maxSelectedKeys
        || intent.ranges.length > 1 || ![...intent.keys, ...intent.exclusions].every((key) => typeof key === 'string')
        || intent.ranges.some((range) => typeof range.fromKey !== 'string' || typeof range.toKey !== 'string'))
        return { state: 'error', reason: 'invalid-selection' };
      selection = structuredClone(intent); return { state: 'ready' };
    },
    key(event) {
      if (event.editing || event.isComposing || event.altKey || event.metaKey) return { state: 'ignored' };
      if (!config.count) return { state: 'ignored' };
      const old = focus ?? { key: config.keyAt(0), index: 0, column: 0 };
      let index = pending?.index ?? old.index, column = pending?.column ?? old.column;
      switch (event.key) {
        case 'ArrowDown': index++; break;
        case 'ArrowUp': index--; break;
        case 'ArrowRight': column += config.direction === 'rtl' ? -1 : 1; break;
        case 'ArrowLeft': column += config.direction === 'rtl' ? 1 : -1; break;
        case 'Home': if (event.ctrlKey || config.role === 'listbox') index = 0; column = 0; break;
        case 'End': if (event.ctrlKey || config.role === 'listbox') index = config.count - 1; column = config.columnCount - 1; break;
        case 'PageDown': index += config.pageRows; break;
        case 'PageUp': index -= config.pageRows; break;
        case ' ': return focus ? toggle(focus.key) : { state: 'ignored' };
        case 'Enter': return focus ? { state: 'activate', key: focus.key, column: focus.column } : { state: 'ignored' };
        case 'Escape': return { state: 'return-focus' };
        default: return { state: 'ignored' };
      }
      const result = focusIndex(index, column);
      if (event.shiftKey && typeof old.key === 'string' && result.state === 'ready') {
        rangeAnchor ??= old.key;
        selection = { mode: 'keys', keys: [], exclusions: [], ranges: [{ fromKey: rangeAnchor, toKey: focus.key }],
          query: config.query, snapshot: config.snapshot };
      }
      else if (event.shiftKey && result.state === 'loading') {
        rangeAnchor ??= old.key; pending = {...pending,fromKey:rangeAnchor,query:config.query,snapshot:config.snapshot};
      }
      else if (!event.shiftKey) rangeAnchor = null;
      return result;
    },
  };
}
