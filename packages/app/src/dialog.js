//@ts-check
/** The app binding delegates modal DOM and cleanup to the view owner. */
import { createDialog } from '@jarenjs/view/helpers/dialog';
import { AppRuntimeError, APP_CODES } from './errors.js';
/**
 * @typedef {import('@jarenjs/view/helpers/dialog').DialogProps & {close: string | {action: string, with?: any, event?: string[]}}} DialogWidgetProps
 * @typedef {Object} DialogWidgetOptions
 * @property {Record<string, import('@jarenjs/view').WidgetDef>} [widgets] - Nested content widget registry.
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
    mount(host, props, emit) {
      check(props);
      const handle = { props, owner: null };
      handle.owner = createDialog(host, props, { widgets: options.widgets, onEvent: emit,
        onClose: (_reason, event) => emit(handle.props.close, event) });
      return handle;
    },
    update(handle, props) { check(props); handle.props = props; handle.owner.update(props); },
    unmount(handle) { handle.owner.dispose(); },
  };
}
