//@ts-check
/** The existing Flow editor as a project-file widget. Its private app only
 * receives the editor's local effects; document effects are recorded, never
 * delegated to the website. Destroy owns the nested app and pending DAG. */
import { semanticKey } from '@jarenjs/core/object';
import { documentKey } from '../../resolve.js';
import { createFlowEditor } from './mount.js';

// Member order counts below a flow document's top-level slots (a query
// node's bindings, a guard's `$let`) and in its input, which a flow reads
// through queries: a reorder there is an edit to publish, or a new mount.
const inputKeyOf = (input) => semanticKey(input ?? null, { ordered: true });

export function createProjectFlowWidget(env = {}) {
  const boot = (handle, props) => {
    handle.name = props.name;
    handle.revision = props.revision;
    handle.key = documentKey(props.kind, props.doc);
    handle.inputKey = inputKeyOf(props.input);
    handle.pendingEcho = false;
    const { app, editor } = createFlowEditor(handle.host, { ...env,
      kind: props.kind, document: props.doc, input: props.input, resetDocument: true, mintFromCount: false,
      onError: err => handle.emit({ action: 'project/stage-error', with: err.message }),
    });
    handle.app = app; handle.editor = editor;
    app.subscribe((state) => {
      const key = documentKey(state.flow.kind, state.flow.doc);
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
      if (h.name === props.name && h.key === documentKey(props.kind, props.doc)
        && h.inputKey === inputKeyOf(props.input)
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
