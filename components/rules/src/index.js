//@ts-check
/** Draft and review state; all evaluation and domain command services are injected. */
import { cloneJson, deepFreeze, isJsonValue } from '@jarenjs/core/object';

/**
 * Preserve draft text/caret independently of asynchronous preview publications.
 * @param {{text:string,preview:(text:string)=>any,command?:(request:any)=>any,onChange?:(state:any)=>void,maxChanges?:number}} options
 */
export function createRuleEditor(options) {
  if (typeof options?.text !== 'string' || typeof options.preview !== 'function') throw new TypeError('Rule editor needs a draft and preview service');
  let text = options.text, start = 0, end = 0, plan = null, phase = 'draft', message = '', generation = 0, disposed = false, committing = null;
  const selected = new Set();
  const maxChanges = options.maxChanges ?? 10000;
  if (!Number.isSafeInteger(maxChanges) || maxChanges < 1) throw new TypeError('Invalid preview change credit');
  const state = () => deepFreeze(cloneJson({ text, selectionStart: start, selectionEnd: end, plan, selected: [...selected], phase, message, reportOnly: typeof options.command !== 'function' }));
  const publish = () => { if (!disposed) options.onChange?.(state()); };
  return {
    state,
    /** Every input event updates the authoritative typing buffer before another render. */
    edit(value, selectionStart = value.length, selectionEnd = selectionStart) {
      if (disposed) return;
      if (typeof value !== 'string' || !Number.isSafeInteger(selectionStart) || !Number.isSafeInteger(selectionEnd)
        || selectionStart < 0 || selectionEnd < selectionStart || selectionEnd > value.length) throw new TypeError('Invalid draft/caret');
      if (value !== text) { generation++; plan = null; selected.clear(); phase = 'draft'; message = ''; }
      text = value; start = selectionStart; end = selectionEnd; publish();
    },
    async preview() {
      if (disposed) return state();
      const mine = ++generation; phase = 'previewing'; message = ''; publish();
      try {
        const result = await options.preview(text);
        if (disposed || mine !== generation) return state();
        if (!isJsonValue(result) || !result || typeof result.id !== 'string' || !Array.isArray(result.changes)
          || result.changes.length > maxChanges || result.changes.some((change) => !change || typeof change.id !== 'string' || !change.id
            || typeof change.field !== 'string' || !change.before || typeof change.before.present !== 'boolean' || !Object.hasOwn(change, 'proposed'))
          || result.errors !== undefined && !Array.isArray(result.errors)
          || new Set(result.changes.map((change) => change.id)).size !== result.changes.length)
          throw new TypeError('Invalid or oversized preview');
        if (plan?.id !== result.id) selected.clear();
        plan = deepFreeze(cloneJson(result)); phase = 'review';
      }
      catch (error) {
        if (!disposed && mine === generation) {
          let reason = 'Check the rule document.';
          try { if (typeof error?.message === 'string') reason = error.message.slice(0, 512); }
          catch { /* Host failures may contain inaccessible properties. */ }
          phase = 'error'; message = `Preview failed: ${reason}`; plan = null; selected.clear();
        }
      }
      publish(); return state();
    },
    /** Stable change IDs survive unmounted or evicted presentation rows. */
    select(id, enabled = true) {
      if (disposed || !plan?.changes.some((change) => change.id === id)) return false;
      if (enabled) selected.add(id); else selected.delete(id);
      publish(); return true;
    },
    /** Double admission shares one command; the injected command owns transactional revalidation. */
    commit() {
      if (committing) return committing;
      if (disposed || !plan || phase !== 'review' || typeof options.command !== 'function' || !selected.size)
        return Promise.resolve({ state: 'refused', reason: 'no-reviewed-selection' });
      const selection = [...selected].sort(), request = deepFreeze(cloneJson({ plan, selection, key: JSON.stringify([plan.id, selection]) }));
      const mine = generation; phase = 'committing'; message = ''; publish();
      committing = Promise.resolve().then(() => options.command(request)).then((result) => {
        if (!isJsonValue(result)) throw new TypeError('Command result must be JSON');
        if (!disposed && mine === generation) { phase = 'review'; message = ['committed', 'replay'].includes(result?.state) ? 'Selected changes committed.' : 'Command refused. Preview current data again.'; }
        return result;
      }).catch(() => { if (!disposed && mine === generation) { phase = 'review'; message = 'Command failed. Preview current data again.'; } return { state: 'error', reason: 'command-failed' }; })
        .finally(() => { committing = null; publish(); });
      return committing;
    },
    /** Fence late preview callbacks; a command already accepted remains host-owned. */
    dispose() { disposed = true; generation++; selected.clear(); plan = null; },
  };
}
