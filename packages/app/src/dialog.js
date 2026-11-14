//@ts-check
/** The app binding delegates modal DOM and cleanup to the view owner. */
import { createDialog } from '@jarenjs/view/helpers/dialog';
import { AppRuntimeError, APP_CODES } from './errors.js';
/**
 * @typedef {import('@jarenjs/view/helpers/dialog').DialogProps & {close: string | {action: string, with?: any, event?: string[]}}} DialogWidgetProps
 * @typedef {Object} DialogWidgetOptions
 * @property {Record<string, import('@jarenjs/view').WidgetDef>} [widgets] - Nested content widget registry.
 *   Absent, the content renders with the registry the dialog itself was
 *   mounted from (the renderer's `context.widgets`). The content renders
 *   under the app's controlled mode too (`context.controlled`).
 * @property {Readonly<Record<string, unknown>> | (() => Readonly<Record<string, unknown>> | undefined)} [messages] -
 *   The reader's compiled `@jarenjs/locales` pack (or a function answering
 *   the current one, read at each mount) for the dialog's own words (its
 *   Close button); a `closeLabel` prop still wins. Absent: English.
 */
/**
 * Register as an ordinary jaren-widget. Props carry id/title/open/content,
 * optional focus refs/closeLabel and a close action binding. The close intent
 * uses emit; the action changes open to false. No DOM enters app state.
 * @param {DialogWidgetOptions} [options]
 * @returns {import('@jarenjs/view').WidgetDef}
 */
export function createDialogWidget(options = {}) {
  function check(props) {
    const action = typeof props?.close === 'string' ? props.close : props?.close?.action;
    if (typeof action !== 'string' || !action.trim()) throw new AppRuntimeError('JA2022', APP_CODES.JA2022);
  }
  return {
    mount(host, props, emit, context) {
      check(props);
      const handle = { props, owner: null };
      const messages = typeof options.messages === 'function' ? options.messages() : options.messages;
      handle.owner = createDialog(host, props, { widgets: options.widgets ?? context?.widgets, onEvent: emit,
        ...(messages == null ? {} : { messages }),
        ...(context?.controlled === undefined ? {} : { controlled: context.controlled }),
        onClose: (_reason, event) => emit(handle.props.close, event) });
      return handle;
    },
    update(handle, props) { check(props); handle.props = props; handle.owner.update(props); },
    unmount(handle) { handle.owner.dispose(); },
  };
}
