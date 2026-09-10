//@ts-check
/** Project-owned model workers. File switches release views/subscriptions;
 * model changes, deletion, project replacement and app teardown release stores. */
import { compileContract } from '@jarenjs/contract';
import { openPortClient } from '@jarenjs/contract/port';
import { createDomRenderer } from '@jarenjs/view';
import { semanticKey } from '@jarenjs/core/object';
import { applyJSONPatch } from '@jarenjs/json/patch';
import { resolveProjectFile, projectFileContext } from '@jarenjs/studio';
import contractDoc from '../contracts/data.contract.json' with { type: 'json' };

const contract = compileContract(contractDoc);
const SCAN = [{ $for: { row: '$[*]' }, $return: '$row' }];
const unwrap = (outcome) => {
  if (outcome.ok) return outcome.value;
  throw Object.assign(new Error(outcome.error.details?.message ?? outcome.error.message), {
    code: outcome.error.details?.code ?? outcome.error.code,
  });
};

export function createProjectDataRuntime(options = {}) {
  const workers = new Map();
  const retire = (name) => {
    const entry = workers.get(name);
    if (!entry) return;
    workers.delete(name);
    entry.client.close(); entry.worker.terminate();
  };
  const dispose = () => { for (const name of [...workers.keys()]) retire(name); };
  const sync = (project, reset = false) => {
    if (reset) { dispose(); return; }
    for (const name of workers.keys()) {
      if (!project.files.some((f) => f.name === name && f.kind === 'model')) retire(name);
    }
  };
  const acquire = (project, file) => {
    const route = projectFileContext(project, file);
    const modelFile = file.kind === 'model' ? file : route.model;
    if (!modelFile) throw new Error('Choose a model file for this query.');
    const model = resolveProjectFile(project, modelFile.name).doc;
    const names = Object.keys(model.collections ?? {});
    const collection = route.collection ?? (names.length === 1 ? names[0] : null);
    if (collection === null || !names.includes(collection))
      throw new Error('Choose a collection from the model in the file routing controls.');
    let seed = null;
    if (modelFile.input !== undefined) {
      const source = projectFileContext(project, modelFile).input;
      seed = JSON.parse(source.text);
      if (!seed || typeof seed !== 'object' || Array.isArray(seed)
        || Object.entries(seed).some(([name, rows]) => !names.includes(name) || !Array.isArray(rows)))
        throw new Error('A model seed must be an object mapping collection names to arrays of documents.');
    }
    const key = semanticKey({ model, seed });
    let entry = workers.get(modelFile.name);
    if (entry && entry.key !== key) { retire(modelFile.name); entry = null; }
    if (!entry) {
      const worker = options.createWorker ? options.createWorker()
        : new Worker(new URL('../project-db-worker.js', import.meta.url), { type: 'module' });
      const client = openPortClient(contract, { channel: worker, timeoutMs: 15_000 });
      const request = async (op, args) => unwrap(await client.invoke(op, args));
      entry = { worker, client, key, request, ready: null };
      workers.set(modelFile.name, entry);
      const owned = entry;
      entry.ready = request('data.init', null).then(async () => {
        const opened = await request('data.open', { model });
        for (const [collection, rows] of Object.entries(seed ?? {}))
          for (const doc of rows) await request('data.insert', { collection, doc });
        return opened;
      })
        .catch((error) => {
          if (workers.get(modelFile.name) === owned) retire(modelFile.name);
          throw error;
        });
    }
    return { entry, collection, modelName: modelFile.name };
  };

  const draw = (h) => {
    if (h.dead) return;
    h.render(['section', { class: 'project-data' },
      ['p', {}, 'Private SQLite store · ', h.modelName ?? '',
        ' · rows last until the model or seed changes, or the project closes.'],
      ['p', { role: 'status', class: 'project-data-status' }, h.status],
      ['label', {}, 'Insert document (JSON)', ['textarea', {
        class: 'editor project-data-insert', 'aria-label': 'Insert document (JSON)',
        value: h.draft, on: { input: 'draft' }, rows: 4,
      }]],
      ['button', { class: 'btn', type: 'button', on: { click: 'insert' }, disabled: !h.ready }, 'Insert row'],
      ['label', {}, 'Delete key (JSON)', ['input', {
        class: 'editor line', 'aria-label': 'Delete key (JSON)', value: h.deleteDraft, on: { input: 'delete-draft' },
      }]],
      ['button', { class: 'btn', type: 'button', on: { click: 'delete' }, disabled: !h.ready }, 'Delete row'],
      ['h3', {}, 'Result'], ['pre', { class: 'project-data-result' }, JSON.stringify(h.result, null, 2)],
      ['h3', {}, 'Live result'], ['pre', { class: 'project-data-live' }, JSON.stringify(h.live, null, 2)],
      ['details', {}, ['summary', {}, 'Query plan'],
        ['pre', { class: 'project-data-plan' }, JSON.stringify(h.plan, null, 2)]],
    ]);
  };
  const start = async (h, props) => {
    h.subscription?.stop();
    const generation = ++h.generation;
    const current = () => !h.dead && h.generation === generation;
    h.props = props; h.ready = false; h.status = 'Opening SQLite…'; draw(h);
    try {
      const project = { files: props.files };
      const file = props.files.find((f) => f.name === props.name);
      const { entry, collection, modelName } = acquire(project, file);
      h.modelName = modelName;
      await entry.ready;
      if (!current()) return;
      h.entry = entry; h.collection = collection;
      const document = file.kind === 'model' ? SCAN : resolveProjectFile(project, file.name).doc;
      const args = { collection, document };
      const result = await entry.request('data.execute', args);
      const plan = await entry.request('data.explain', args);
      if (!current()) return;
      h.result = result; h.plan = plan; h.ready = true; h.status = 'Ready'; draw(h);
      h.subscription = entry.client.subscribe('data.live', args, {
        onSnapshot: (value) => { if (current()) { h.live = value; draw(h); } },
        onPatch: ({ patch }) => { if (current()) { h.live = applyJSONPatch(h.live, patch); draw(h); } },
        onError: (outcome) => {
          if (current()) { h.status = `Live query: ${outcome.error.details?.message ?? outcome.error.message}`; draw(h); }
        },
        onEnd: ({ reason }) => { if (current()) { h.status = `Live query ended: ${reason}`; draw(h); } },
      });
    }
    catch (error) { if (current()) { h.status = String(error.message ?? error); draw(h); } }
  };
  const widget = {
    mount(host, props) {
      const h = { dead: false, generation: 0, draft: '{"id":"n1","title":"New note","points":20}',
        deleteDraft: '"n1"', result: null, plan: null, live: null, props };
      h.render = createDomRenderer(host, { onEvent: async (binding, event) => {
        if (binding === 'draft') { h.draft = event.target.value; return; }
        if (binding === 'delete-draft') { h.deleteDraft = event.target.value; return; }
        if (!h.ready) return;
        const generation = h.generation;
        try {
          const value = JSON.parse(binding === 'insert' ? h.draft : h.deleteDraft);
          await h.entry.request(binding === 'insert' ? 'data.insert' : 'data.delete', {
            collection: h.collection, ...(binding === 'insert' ? { doc: value } : { key: value }),
          });
          if (h.dead || h.generation !== generation) return;
          h.status = 'Committed'; draw(h);
        }
        catch (error) { if (!h.dead && h.generation === generation) { h.status = error.message; draw(h); } }
      } });
      void start(h, props); return h;
    },
    update(h, props) {
      if (h.props.files === props.files && h.props.name === props.name && h.props.revision === props.revision) return;
      void start(h, props);
    },
    unmount(h) { h.dead = true; h.generation++; h.subscription?.stop(); h.render.destroy(); },
  };
  const execute = async (project, name) => {
    const file = project.files.find((f) => f.name === name);
    const { entry, collection } = acquire(project, file);
    await entry.ready;
    const document = file.kind === 'model' ? SCAN : resolveProjectFile(project, name).doc;
    const args = { collection, document };
    const result = await entry.request('data.execute', args);
    return { result, plan: await entry.request('data.explain', args) };
  };
  return { widget, sync, dispose, acquire, execute };
}
