//@ts-check
/** Native modal ownership inside one renderer-owned widget host. */
import { CodedError } from '@jarenjs/core/errors';
import { createDomRenderer } from '../dom.js';
import { findByRef } from './focus.js';

/** Stable view host refusals, using the shared coded-error owner. */
export const DIALOG_CODES = Object.freeze({
  JV1001: 'dialog properties or host ownership are malformed',
  JV1002: 'native modal dialog execution is unavailable',
});
/**
 * @typedef {Object} DialogProps
 * @property {string} id - Unique DOM id; the visible title uses id + '-title'.
 * @property {string} title - Nonempty visible accessible name.
 * @property {boolean} open
 * @property {import('../vnode.js').VNodeJson} [content]
 * @property {string} [initialFocusRef] - Exact data-ref inside the dialog.
 * @property {string} [fallbackFocusRef] - Exact data-ref in the owner document.
 * @property {string} [closeLabel='Close'] - Visible close button text.
 */
/**
 * @typedef {Object} DialogOptions
 * @property {(reason: 'escape'|'button'|'native', event: Event) => void} [onClose]
 * @property {import('../dom.js').EventBindingHandler} [onEvent]
 * @property {Record<string, import('../dom.js').WidgetDef>} [widgets]
 * @typedef {{update: (props: DialogProps) => void, dispose: () => void}} DialogOwner
 */
function refuse(code) { throw new CodedError('ViewHostError', code, DIALOG_CODES[code]); }
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 1024;
function properties(value) {
  if (value === null || typeof value !== 'object' || !text(value.id) || /\s/.test(value.id)
    || !text(value.title) || typeof value.open !== 'boolean'
    || (value.closeLabel !== undefined && !text(value.closeLabel))
    || (value.initialFocusRef !== undefined && !text(value.initialFocusRef))
    || (value.fallbackFocusRef !== undefined && !text(value.fallbackFocusRef))) refuse('JV1001');
  return value;
}

/**
 * Own a native dialog and a nested vnode renderer. The browser owns its modal
 * stack and background inertness; this owner never changes background attrs.
 * Close controls emit an intent. Update open=false to commit the close.
 * Content uses ordinary light-DOM controls and nonpositive tabindex values.
 * @param {HTMLElement} host - Connected, empty widget host; never reparented.
 * @param {DialogProps} initial
 * @param {DialogOptions} [options]
 * @returns {Readonly<DialogOwner>}
 */
export function createDialog(host, initial, options = {}) {
  properties(initial);
  if (!host?.ownerDocument || !host.isConnected || host.childNodes.length
    || !options || (options.onClose !== undefined && typeof options.onClose !== 'function')) refuse('JV1001');
  const doc = host.ownerDocument;
  const dialog = doc.createElement('dialog');
  if (typeof dialog.showModal !== 'function' || typeof dialog.close !== 'function') refuse('JV1002');
  const title = doc.createElement('h2'), content = doc.createElement('div'), closeButton = doc.createElement('button');
  dialog.setAttribute('class', 'jaren-dialog');
  dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
  title.setAttribute('tabindex', '-1');
  closeButton.setAttribute('type', 'button'); closeButton.setAttribute('data-dialog-close', '');
  dialog.appendChild(title); dialog.appendChild(content); dialog.appendChild(closeButton); host.appendChild(dialog);
  let render;
  try { render = createDomRenderer(content, { document: doc, onEvent: options.onEvent, widgets: options.widgets }); }
  catch (error) { host.removeChild(dialog); throw error; }
  let props = initial, disposed = false, opener = null, suppressedCloses = 0;

  function focusable() {
    // Native selectors handle disabled fieldsets. Layout checks exclude hidden
    // controls. Re-evaluate on each key press; there is no stale focus cache.
    return [...dialog.querySelectorAll('button, input, select, textarea, a[href], [tabindex], [contenteditable="true"], summary')]
      .filter(node => node.tabIndex >= 0 && !node.matches(':disabled') && !node.closest('[inert]')
        && node.closest('dialog') === dialog && node.getClientRects().length > 0
        && doc.defaultView.getComputedStyle(node).visibility !== 'hidden');
  }
  function focusInitial() {
    const requested = props.initialFocusRef ? findByRef(dialog, props.initialFocusRef) : null;
    requested?.focus?.();
    if (requested && doc.activeElement === requested) return;
    (focusable()[0] ?? title).focus();
    if (!dialog.contains(doc.activeElement)) title.focus();
  }
  function restore() {
    const previous = opener; opener = null;
    if (previous?.isConnected) previous.focus?.();
    if (doc.activeElement !== previous && props.fallbackFocusRef) findByRef(doc.body, props.fallbackFocusRef)?.focus?.();
  }
  function close() {
    if (!dialog.open) return;
    suppressedCloses++; dialog.close(); restore();
  }
  function request(reason, event) {
    if (!disposed && dialog.open) options.onClose?.(reason, event);
  }
  function onCancel(event) {
    event.preventDefault(); event.stopPropagation(); request('escape', event);
  }
  function onClick(event) { request('button', event); }
  function onNativeClose(event) {
    if (suppressedCloses) { suppressedCloses--; return; }
    restore(); if (!disposed) options.onClose?.('native', event);
  }
  function onKey(event) {
    if (event.key !== 'Tab' || event.defaultPrevented || event.target.closest('dialog') !== dialog) return;
    const controls = focusable(), first = controls[0] ?? title, last = controls.at(-1) ?? title;
    const active = doc.activeElement;
    if (!controls.length || (event.shiftKey ? active === first || !controls.includes(active) : active === last || !controls.includes(active))) {
      event.preventDefault(); (event.shiftKey ? last : first).focus();
    }
  }
  dialog.addEventListener('cancel', onCancel);
  dialog.addEventListener('close', onNativeClose);
  dialog.addEventListener('keydown', onKey);
  closeButton.addEventListener('click', onClick);

  const owner = {
    update(next) {
      if (disposed) return;
      properties(next);
      for (const [id, element] of [[next.id, dialog], [`${next.id}-title`, title]]) {
        const existing = doc.getElementById(id);
        if (existing && existing !== element) refuse('JV1001');
      }
      props = next;
      dialog.setAttribute('id', props.id); title.setAttribute('id', `${props.id}-title`);
      dialog.setAttribute('aria-labelledby', `${props.id}-title`);
      title.textContent = props.title; closeButton.textContent = props.closeLabel ?? 'Close';
      const wasFocused = dialog.contains(doc.activeElement), opening = props.open && !dialog.open;
      if (opening) { opener = doc.activeElement; dialog.showModal(); }
      // Destroy nested modals before closing their parent. Closed widgets keep
      // no active content renderer children, subscriptions or nested owners.
      render(props.open ? props.content ?? null : null);
      if (!props.open) close();
      else if (opening || (wasFocused && !dialog.contains(doc.activeElement))) focusInitial();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      dialog.removeEventListener('cancel', onCancel); dialog.removeEventListener('close', onNativeClose);
      dialog.removeEventListener('keydown', onKey); closeButton.removeEventListener('click', onClick);
      try { render.destroy(); }
      finally { try { close(); } finally { host.removeChild(dialog); } }
    },
  };
  try { owner.update(initial); }
  catch (error) { try { owner.dispose(); } catch { /* preserve the original mount failure */ } throw error; }
  return Object.freeze(owner);
}
