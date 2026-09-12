//@ts-check
/** Project editor transitions, shared by every host. */
export const PROJECT_ACTIONS = {
  // the Project IDE (#/project, boundaries/project.js): a jaren-project
  // edited as one document. The editor commits the ACTIVE file's text
  // through the `project-edit` effect (it rewrites the file by name, in
  // JS — an array index a patch path cannot compute); the changed
  // `/project/files` feed then drives the debounced commit
  // (`project/committed`) that folds in the last-good app stage.
  // every keystroke publishes to the typing buffer. This is what the
  // CONTROLLED editor is reasserted with: without it a render between the
  // keystroke and the blur would rewrite the box with the still-stale
  // committed text, clearing the browser's dirty-value flag so the commit
  // never fires and the typing is lost. Cheap by construction — it touches
  // no file, so nothing revalidates.
  'project/buffer-text': {
    patch: [{
      op: 'replace',
      path: '/project/buffer',
      value: { file: '$.project.active', text: '$event.value', dirty: true },
    }],
  },
  // resolve a conflict the human's way round: drop the buffer, so the
  // incoming (committed) text is what the editor shows
  'project/buffer-accept': {
    patch: [{ op: 'replace', path: '/project/buffer', value: null }],
  },
  // the commit (blur): the buffer has served its purpose, so it clears
  // here — on the HUMAN's own commit, never on `project/files-set`, which
  // is also how an external write lands and must not drop a dirty buffer
  'project/route-input': { effects: [{ run: 'project-route', with: { member: 'input', value: '$event.value' } }] },
  'project/route-model': { effects: [{ run: 'project-route', with: { member: 'model', value: '$event.value' } }] },
  'project/route-collection': { effects: [{ run: 'project-route', with: { member: 'collection', value: '$event.value' } }] },
  'project/artifact-edit': { effects: [{ run: 'project-artifact-edit', with: '$payload' }] },
  'project/file-text': {
    patch: [{ op: 'replace', path: '/project/buffer', value: null }],
    effects: [{ run: 'project-edit', with: { text: '$event.value' } }],
  },
  'project/files-set': {
    patch: [
      { op: 'replace', path: '/project/files', value: '$payload.files' },
      { op: 'replace', path: '/project/dirty', value: true },
    ],
  },
  // switching files drops the buffer: it belongs to the file you left
  'project/active': {
    patch: [
      { op: 'replace', path: '/project/active', value: '$payload' },
      { op: 'replace', path: '/project/buffer', value: null },
      // picking a file in the rail — or an error line in the strip — is a
      // request to EDIT it, and on a phone the rail is a different pane
      // from the editor. Carry the user across (invisible on desktop).
      { op: 'replace', path: '/project/mobilePane', value: 'editor' },
    ],
  },
  // the debounced boundary reports the last-good app mount + reboot
  // revision (an invalid edit keeps the previous — the stage never blanks)
  'project/committed': {
    patch: [
      { op: 'replace', path: '/project/mount', value: '$payload.mount' },
      { op: 'replace', path: '/project/revision', value: '$payload.revision' },
      { op: 'replace', path: '/project/dirty', value: false },
    ],
  },
  // explicit Run: force-commit + restart the app stage (or re-run a
  // transform file). Pressing Run is a request to watch it happen, so on
  // a phone the stage comes forward with it.
  'project/execute': {
    patch: [{ op: 'replace', path: '/project/mobilePane', value: 'stage' }],
    effects: [{ run: 'project-editor-run', with: '$payload' }],
  },
  'project/run': {
    patch: [{ op: 'replace', path: '/project/mobilePane', value: 'stage' }],
    effects: [{ run: 'project-run' }],
  },
  'project/autorun': {
    patch: [
      { op: 'replace', path: '/project/layout/autorun', value: { $not: '$.project.layout.autorun' } },
      { op: 'replace', path: '/project/dirty', value: true },
    ],
  },
  // a transform file's run result (render nodes) — keyed by file name
  'project/result': {
    patch: [{ op: 'add', path: { $concat: ['/project/results/',
      { $replace: [{ $replace: ['$payload.name', '~', '~0'] }, '/', '~1'] },
    ] }, value: '$payload.result' }],
  },
  // file management: add (a kind from the rail select), delete (× per row),
  // rename (the editor-head name field). Each rewrites the files array in
  // JS (an effect), then a patch action lands the result; a name change
  // resets the mount/results so the stage re-establishes cleanly.
  'project/add-file': { effects: [{ run: 'project-add', with: { kind: '$event.value' } }] },
  'project/delete': { effects: [{ run: 'project-delete', with: { name: '$payload' } }] },
  // the name field's typing buffer — the sibling of `project/buffer-text`,
  // and cheap the same way: it touches no file, so nothing revalidates
  'project/rename-draft': {
    patch: [{
      op: 'replace',
      path: '/project/renameDraft',
      value: { file: '$.project.active', text: '$event.value' },
    }],
  },
  // the commit (blur or Enter), shaped like `project/file-text`: the draft
  // has served its purpose so it clears, and the effect reads the EVENT —
  // the value the human actually committed, with no dependence on the
  // keystroke's own transaction having drained first
  'project/rename': {
    patch: [{ op: 'replace', path: '/project/renameDraft', value: null }],
    effects: [{ run: 'project-rename', with: { name: '$event.value' } }],
  },
  'project/added': {
    patch: [
      { op: 'replace', path: '/project/files', value: '$payload.files' },
      { op: 'replace', path: '/project/active', value: '$payload.active' },
      { op: 'replace', path: '/project/dirty', value: true },
      { op: 'replace', path: '/project/buffer', value: null },
    ],
  },
  'project/structural': {
    patch: [
      { op: 'replace', path: '/project/files', value: '$payload.files' },
      { op: 'replace', path: '/project/active', value: '$payload.active' },
      { op: 'replace', path: '/project/mount', value: null },
      { op: 'replace', path: '/project/results', value: {} },
      { op: 'replace', path: '/project/dirty', value: true },
      { op: 'replace', path: '/project/buffer', value: null },
    ],
  },
  // the nested app's own boot/runtime failure (the stage widget emits it)
  'project/stage-error': { patch: [{ op: 'replace', path: '/project/stageError', value: '$payload' }] },
  // open a whole project (a template card, or an inbound share token)
  'project/open': {
    patch: [
      { op: 'replace', path: '/project/project', value: { $default: ['$payload.project', '0.1'] } },
      { op: 'replace', path: '/project/name', value: '$payload.name' },
      { op: 'replace', path: '/project/files', value: '$payload.files' },
      { op: 'replace', path: '/project/active', value: '$payload.active' },
      { op: 'replace', path: '/project/layout', value: '$payload.layout' },
      { op: 'replace', path: '/project/mount', value: null },
      { op: 'replace', path: '/project/revision', value: 0 },
      { op: 'replace', path: '/project/dirty', value: false },
      { op: 'replace', path: '/project/results', value: {} },
      { op: 'replace', path: '/project/stageError', value: null },
      { op: 'replace', path: '/project/buffer', value: null },
      // opening a project is a request to SEE it — on a phone that means
      // the stage, not the editor it happens to have activated (the same
      // move `play/loaded` makes when an example is picked). Desktop
      // shows every pane, so this patch is invisible there.
      { op: 'replace', path: '/project/mobilePane', value: 'stage' },
    ],
  },
  'project/template': { effects: [{ run: 'project-template', with: { id: '$payload' } }] },
  // download the designated app file's document (the Studio's takeaway)
  'project/download': { effects: [{ run: 'project-download' }] },
  'project/eject': { effects: [{ run: 'project-eject' }] },
  'project/export': { effects: [{ run: 'project-export' }] },
  // the layout switcher (which grid mode) + the splitter (where the handle
  // sits within that mode); the splitter widget commits on pointer-up
  'project/layout-mode': { patch: [{ op: 'replace', path: '/project/layout/mode', value: '$payload' }] },
  'project/layout-ratio': { patch: [{ op: 'replace', path: '/project/layout/ratio', value: '$payload' }] },
  // the phone pane switcher (Files · Editor · Stage) — pure chrome, and
  // deliberately NOT part of `layout`: `layout` is a jaren-project member
  // that saves, shares and downloads with the document, and which pane a
  // phone happened to be showing is not a property of the project
  'project/pane': { patch: [{ op: 'replace', path: '/project/mobilePane', value: '$payload' }] },

};

/** Compare at the serialized app transition, including a queued manual edit. */
PROJECT_ACTIONS['project/replace'] = {
  $if: [
    { $eq: [{
      project: { $default: ['$.project.project', '0.1'] },
      files: { $default: ['$.project.files', []] },
      active: { $default: ['$.project.active', null] },
      layout: '$.project.layout',
      name: { $default: ['$.project.name', 'Untitled project'] },
    }, '$payload.expected'] },
    { patch: [
      { op: 'replace', path: '/project/project', value: '$payload.document.project' },
      { op: 'replace', path: '/project/name', value: '$payload.document.name' },
      { op: 'replace', path: '/project/files', value: '$payload.document.files' },
      { op: 'replace', path: '/project/active', value: '$payload.document.active' },
      { op: 'replace', path: '/project/layout', value: '$payload.document.layout' },
      { op: 'replace', path: '/project/dirty', value: true },
    ], effects: [{ run: 'project-accepted', with: '$payload.requestId' }] },
    { effects: [{ run: 'project-refused', with: '$payload.requestId' }] },
  ],
};
