import { createDialogWidget, type DialogWidgetProps } from '@jarenjs/app/dialog';
import { createDialog, type DialogOwner, type DialogProps } from '@jarenjs/view/helpers/dialog';
import { findByRef } from '@jarenjs/view/helpers/focus';
import type { WidgetDef } from '@jarenjs/view';
const widgets: Record<string, WidgetDef> = {};
widgets.dialog = createDialogWidget({ widgets });
const props: DialogWidgetProps = { id: 'settings', title: 'Settings', open: true,
  content: ['input', { 'data-ref': 'first' }], initialFocusRef: 'first', close: { action: 'close' } };
const owner: DialogOwner = createDialog(document.createElement('div'), props, {
  onClose: (reason, event) => { const r: 'escape' | 'button' | 'native' = reason; void [r, event.type]; }, widgets,
});
owner.update(props); owner.dispose();
findByRef(document.body, 'fallback');
// @ts-expect-error the modal state must be explicit boolean data
const invalid: DialogProps = { id: 'dialog', title: 'Title', open: 'true' };
// @ts-expect-error a widget must carry a close action binding
const uncloseable: DialogWidgetProps = { id: 'dialog', title: 'Title', open: true };
void [invalid, uncloseable];
