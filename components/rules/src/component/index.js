//@ts-check
/** Schema-guided authoring and bounded review pages over the injected editor. */
import { createDomRenderer } from '@jarenjs/view';
import { buildFormModel } from '@jarenjs/forms';
import { createRuleEditor } from '../index.js';

/**
 * Mount a reusable rule editor. Preview rows are a bounded presentation page;
 * selection remains in the editor by stable ID. Schema fields guide JSON authors.
 * @param {HTMLElement} host @param {any} options
 */
export function mountRuleEditor(host, options) {
  const document = host.ownerDocument;
  const model = buildFormModel(options.schema ?? { type: 'object' });
  const pageSize = options.pageSize ?? 20;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new TypeError('Invalid review page size');
  let page = 0, disposed = false, targetIndex = 0;
  const render = createDomRenderer(host, { document });
  const controller = createRuleEditor({ ...options, onChange: (state) => { refresh(state); options.onChange?.(state); } });
  function refresh(state = controller.state()) {
    if (disposed) return;
    const changes = state.plan?.changes ?? [];
    page = Math.min(page, Math.max(0, Math.ceil(changes.length / pageSize) - 1));
    const fields = (model.children ?? []).map((field) => `${field.pointer ?? field.path ?? field.key}: ${field.label ?? field.title ?? field.key}`);
    let draft = null;
    try { draft = JSON.parse(state.text); } catch { /* Keep incomplete draft text editable. */ }
    const targets = Array.isArray(draft?.targets) ? draft.targets : [];
    targetIndex = Math.min(targetIndex, Math.max(0, targets.length - 1));
    const editableTarget = targets[targetIndex] && typeof targets[targetIndex] === 'object' && !Array.isArray(targets[targetIndex]);
    const writable = (model.children ?? []).filter((field) => !field.readOnly && (!options.writableFields || options.writableFields.includes(field.pointer)));
    render(['section', { class: 'jr-editor', 'aria-label': 'Rule editor' },
      ['div', { class: 'jr-actions' }, ['label', {}, 'Target ', ['select', { 'aria-label': 'Rule target', 'data-rule-target': '', value: String(targetIndex), disabled: !targets.length },
        ...targets.map((target, index) => ['option', { value: String(index) }, target?.id ?? String(index)])]],
      ['label', {}, 'Writable field ', ['select', { 'aria-label': 'Writable field', 'data-rule-field': '', value: targets[targetIndex]?.field ?? '', disabled: !editableTarget },
        ...writable.map((field) => ['option', { value: field.pointer }, field.label])]],
      ['label', {}, ['input', { type: 'checkbox', 'aria-label': 'Target enabled', 'data-rule-enabled': '', checked: targets[targetIndex]?.enabled !== false, disabled: !editableTarget }], 'Enabled']],
      ['label', { class: 'jr-draft-label' }, 'Rule document', ['textarea', { 'data-rule-draft': '', rows: 12, value: state.text, spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', 'aria-label': 'Rule document' }]],
      ['details', {}, ['summary', {}, 'Available schema fields'], ['pre', {}, fields.join('\n') || JSON.stringify(options.schema ?? {}, null, 2)]],
      ['div', { class: 'jr-actions' }, ['button', { type: 'button', 'data-rule-preview': '', disabled: state.phase === 'previewing' }, 'Preview rules'],
        ['button', { type: 'button', 'data-rule-commit': '', disabled: state.reportOnly || state.phase !== 'review' || !state.selected.length }, `Commit selected (${state.selected.length})`]],
      ['p', { role: 'status', 'data-rule-status': '' }, state.message || (state.phase === 'previewing' ? 'Evaluating preview…' : `${changes.length} proposed changes · ${state.selected.length} selected`)],
      ['ul', { 'aria-label': 'Preview diagnostics' }, ...(state.plan?.errors ?? []).map((error) => ['li', {}, `${error.rowId ?? ''} ${error.targetId ?? ''}: ${error.code ?? ''} ${error.message ?? ''} ${error.docPath ?? ''}`]),
        ...(state.plan?.omittedErrors ? [['li', {}, `${state.plan.omittedErrors} further diagnostics omitted by the configured limit.`]] : [])],
      ['ul', { class: 'jr-changes', 'aria-label': 'Proposed changes' }, ...changes.slice(page * pageSize, (page + 1) * pageSize).map((change) =>
        ['li', { key: change.id }, ['label', {}, ['input', { type: 'checkbox', 'data-rule-change': change.id, checked: state.selected.includes(change.id) }],
          `${change.entityId} ${change.field}: ${change.before.present ? JSON.stringify(change.before.value) : '(absent)'} → ${JSON.stringify(change.proposed)}${change.explanation ? ` · ${change.explanation}` : ''}`]])],
      ['nav', { class: 'jr-actions', 'aria-label': 'Preview pages' }, ['button', { type: 'button', 'data-rule-previous': '', disabled: page === 0 }, 'Previous'],
        ['span', {}, `Page ${page + 1} of ${Math.max(1, Math.ceil(changes.length / pageSize))}`],
        ['button', { type: 'button', 'data-rule-next': '', disabled: (page + 1) * pageSize >= changes.length }, 'Next']]]);
  }
  function input(event) {
    const target = event.target;
    if (target.hasAttribute('data-rule-draft')) controller.edit(target.value, target.selectionStart ?? 0, target.selectionEnd ?? 0);
  }
  function change(event) {
    const target = event.target;
    if (target.hasAttribute('data-rule-target')) { targetIndex = Number(target.value); refresh(); return; }
    if (target.hasAttribute('data-rule-field') || target.hasAttribute('data-rule-enabled')) {
      const draft = JSON.parse(controller.state().text);
      if (target.hasAttribute('data-rule-field')) draft.targets[targetIndex].field = target.value;
      else draft.targets[targetIndex].enabled = target.checked;
      controller.edit(JSON.stringify(draft, null, 2)); return;
    }
    const id = target.getAttribute('data-rule-change');
    if (id !== null) controller.select(id, event.target.checked);
  }
  function click(event) {
    const target = event.target;
    if (target.hasAttribute('data-rule-preview')) void controller.preview();
    else if (target.hasAttribute('data-rule-commit')) void controller.commit();
    else if (target.hasAttribute('data-rule-previous')) { page = Math.max(0, page - 1); refresh(); }
    else if (target.hasAttribute('data-rule-next')) { page++; refresh(); }
  }
  host.addEventListener('input', input); host.addEventListener('change', change); host.addEventListener('click', click);
  refresh();
  return { controller, refresh,
    dispose() { if (disposed) return; disposed = true; host.removeEventListener('input', input); host.removeEventListener('change', change); host.removeEventListener('click', click); controller.dispose(); render.destroy(); },
  };
}

/** Existing app widget lifecycle, with all host services injected through options. */
export function createRuleEditorWidget(options) {
  return { mount: (host, props) => mountRuleEditor(host, { ...options, ...props }), update: (handle) => handle.refresh(), unmount: (handle) => handle.dispose() };
}
