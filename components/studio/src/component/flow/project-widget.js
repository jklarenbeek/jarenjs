//@ts-check
/** The existing Flow editor as a project-file widget. Its private app only
 * receives the editor's local effects; document effects are recorded, never
 * delegated to the website. Destroy owns the nested app and pending DAG. */
import { semanticKey } from '@jarenjs/core/object';
import { createFlowEditor } from './mount.js';

export function createProjectFlowWidget(env = {}) {
  const boot = (handle, props) => {
    handle.name = props.name;
    handle.revision = props.revision;
    handle.key = semanticKey(props.doc);
    handle.inputKey = semanticKey(props.input ?? null);
    handle.pendingEcho = false;
    const { app, editor } = createFlowEditor(handle.host, { ...env,
      kind: props.kind, document: props.doc, input: props.input, resetDocument: true, mintFromCount: false,
      onError: err => handle.emit({ action: 'project/stage-error', with: err.message }),
    });
    handle.app = app; handle.editor = editor;
    app.subscribe((state) => {
      const key = semanticKey(state.flow.doc);
      if (key === handle.key) return;
      handle.key = key;
      handle.pendingEcho = true;
      handle.emit({ action: 'project/artifact-edit', with: { name: handle.name, doc: state.flow.doc } });
    });
  };
  const destroy = (h) => { h.editor?.dispose(); h.app = null; };
  return {
    mount(host, props, emit) { const h = { host, emit }; boot(h, props); return h; },
    update(h, props) {
      // An echo of our own edit preserves selection, undo and the run pane.
      if (h.name === props.name && h.key === semanticKey(props.doc)
        && h.inputKey === semanticKey(props.input ?? null)
        && (h.pendingEcho || h.revision === props.revision)) {
        h.pendingEcho = false;
        h.revision = props.revision;
        return;
      }
      destroy(h); boot(h, props);
    },
    unmount: destroy,
  };
}
