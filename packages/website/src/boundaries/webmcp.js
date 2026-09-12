//@ts-check
/** The site's selected ordinary operations, registered through the public adapter. */
import { registerWebMcp } from '@jarenjs/contract/webmcp';
import { JarenValidator } from '@jarenjs/validate';

/** Own only this site's catalog. Every refresh discovers capabilities again.
 * @param {any} app
 * @param {import('@jarenjs/contract/webmcp').WebMcpOptions} [options]
 */
export function registerSiteWebMcp(app, options = {}) {
  let stopped = false, epoch = 0, refreshing = false;
  const editorFor = page => ({ project: app.projectEditor, data: app.dataEditor, flow: app.flowEditor })[page];
  const route = () => app.getState().route.page;
  function definitions() {
    const page = route(), editor = editorFor(page);
    const tool = (name, description, properties, required, execute) => {
      const inputSchema = { type: 'object', properties, required, additionalProperties: false };
      const check = new JarenValidator({ collectErrors: true, skipErrors: false }).compile(inputSchema);
      return { name, description, inputSchema, async execute(input, execution) {
        if (stopped || route() !== page || execution?.signal?.aborted)
          return { ok: false, error: 'This page registration is inactive.' };
        const checked = check(input);
        if (!checked.valid) return { ok: false, error: 'Invalid operation input.', errors: checked.errors };
        if (Object.hasOwn(input, 'revision') && input.revision !== editor.read().revision)
          return { ok: false, conflict: true, error: 'The editor revision changed.' };
        try { return await execute(input); }
        catch (error) { return { ok: false, error: error.message, code: error.code }; }
      } };
    };
    const tools = [tool('jaren_site_read', 'Read the visible page and available editor.', {}, [],
      () => ({ page, editor: editor ? page : null }))];
    if (!editor) return tools;
    const revision = { type: 'string' };
    tools.push(tool('jaren_editor_read', 'Read the current document, raw buffers when available, and revision.', {}, [], () => editor.read()));
    tools.push(tool('jaren_editor_replace', 'Validate and replace the complete document at the observed revision.',
      { document: {}, revision, ...(page === 'flow' ? { kind: { enum: ['fsm', 'dag'] } } : {}) }, ['document', 'revision'], input => editor.replace(input.document, { expectedRevision: input.revision, ...(page === 'flow' ? { kind: input.kind } : {}) })));
    tools.push(tool('jaren_editor_apply', 'Apply a JSON Patch and validate the complete result at the observed revision.',
      { patch: { type: 'array', items: { type: 'object' } }, revision }, ['patch', 'revision'],
      input => editor.apply(input.patch, { expectedRevision: input.revision })));
    const properties = page === 'project' ? { name: { type: 'string' } }
      : page === 'data' ? { operation: { enum: ['query', 'open'] }, externals: { type: 'object' } }
      : { input: {}, event: { type: 'string' } };
    tools.push(tool('jaren_editor_run', 'Explicitly execute the current editor document and return its settled result.',
      { ...properties, revision }, ['revision'], input => { const settings = { ...input }; delete settings.revision; return editor.run(page === 'project' ? settings.name : settings); }));
    return tools;
  }
  let binding = registerWebMcp(definitions(), options), ready = binding.ready, queue = ready;
  function refresh() {
    if (stopped) return ready;
    const previous = binding, identity = ++epoch;
    refreshing = true;
    const closed = previous.dispose();
    ready = queue.then(async () => {
      await closed;
      if (stopped || identity !== epoch) return previous.ready;
      binding = registerWebMcp(definitions(), options);
      const result = await binding.ready;
      if (identity === epoch) refreshing = false;
      return result;
    });
    queue = ready;
    return ready;
  }
  const unsubscribe = app.subscribe((_state, changes) => {
    if (changes?.includes('/route')) void refresh();
  });
  let disposal;
  function dispose() {
    if (disposal) return disposal;
    stopped = true; epoch++; unsubscribe();
    const closed = binding.dispose();
    disposal = Promise.all([closed, ready]).then(() => binding.ready);
    return disposal;
  }
  return { get ready() { return ready; }, get status() { return stopped ? 'disposed' : refreshing ? 'pending' : binding.status; }, refresh, dispose };
}
