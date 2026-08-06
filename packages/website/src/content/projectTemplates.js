//@ts-check
/**
 * Seed projects for the Project IDE (`#/project`). Each is a `jaren-project`
 * — a small tree of typed files — that opens as "New Pen" would: the same
 * document the human edits and an AI authors. The starter is one live
 * `app`; the others show the multi-file split (a `query`/`jslt` transform
 * beside the `data` it runs on), including a host-registered operator
 * (`$npv`) that only validates because each file is checked on its OWN
 * boundary with the operator packs mounted.
 */

/** The live starter app: the `h1` reflects `state.title` (so editing the
 * state block hot-updates it), an UNCONTROLLED scratch input (it survives
 * a hot-update — a reboot clears it), and a string-only action. */
export const STARTER_APP = JSON.stringify({
  state: { title: 'Hello from the studio', note: 'edit me' },
  view: [{
    match: '$',
    body: ['div', { class: 'demo' },
      ['h1', {}, '$.title'],
      ['p', {}, 'This paragraph is state: ', ['strong', {}, '$.note']],
      ['label', { class: 'demo-scratch' }, 'Scratch (uncontrolled): ',
        ['input', { type: 'text', placeholder: 'type here — a hot-update keeps it' }]],
      ['button', { type: 'button', class: 'demo-btn', on: { click: 'shout' } }, 'shout'],
    ],
  }],
  actions: { shout: { patch: [{ op: 'replace', path: '/title', value: 'HELLO!' }] } },
}, null, 2);

const NPV_QUERY = JSON.stringify({ npv: { $npv: ['$.rate', '$.cashflows[*]'] } }, null, 2);
const NPV_DATA = JSON.stringify({ rate: 0.1, cashflows: [-1000, 300, 400, 500] }, null, 2);

const UPPER_JSLT = JSON.stringify({
  $jslt: '0.1',
  rules: [{ match: '$', body: { greeting: { $concat: ['Hi, ', '$.name'] }, tags: '$.tags' } }],
}, null, 2);
const UPPER_DATA = JSON.stringify({ name: 'Ada', tags: ['compiler', 'json'] }, null, 2);

/**
 * The gallery. `files` is the seed tree; `active` names the file the IDE
 * opens on. Kept small and each independently valid.
 * @type {ReadonlyArray<{ id: string, title: string, lead: string,
 *   active: string, files: Array<{ name: string, kind: string, text: string }> }>}
 */
export const PROJECT_TEMPLATES = Object.freeze([
  {
    id: 'starter',
    title: 'Welcome',
    lead: 'A project is many files: a live app, plus a query that runs against a data file. Click a file to edit it — the stage follows.',
    active: 'app.json',
    files: [
      { name: 'app.json', kind: 'app', text: STARTER_APP },
      { name: 'stats.query', kind: 'query', text: JSON.stringify({ mean: { $mean: '$.values[*]' } }, null, 2) },
      { name: 'stats.data', kind: 'data', text: JSON.stringify({ values: [3, 1, 4, 1, 5, 9, 2, 6] }, null, 2) },
    ],
  },
  {
    id: 'finance',
    title: 'Query + data',
    lead: 'A query using the registered $npv operator, run against a data file — the multi-file split.',
    active: 'npv.query',
    files: [
      { name: 'npv.query', kind: 'query', text: NPV_QUERY },
      { name: 'cashflows.data', kind: 'data', text: NPV_DATA },
    ],
  },
  {
    id: 'transform',
    title: 'JSLT + data',
    lead: 'A JSLT transform beside the data it reshapes.',
    active: 'shape.jslt',
    files: [
      { name: 'shape.jslt', kind: 'jslt', text: UPPER_JSLT },
      { name: 'input.data', kind: 'data', text: UPPER_DATA },
    ],
  },
  {
    id: 'validate',
    title: 'Schema + data',
    lead: 'A JSON Schema validating a data file — edit either and watch the report.',
    active: 'user.schema',
    files: [
      { name: 'user.schema', kind: 'schema', text: JSON.stringify({ type: 'object', properties: { name: { type: 'string', minLength: 2 }, age: { type: 'integer', minimum: 0 } }, required: ['name'] }, null, 2) },
      { name: 'user.data', kind: 'data', text: JSON.stringify({ name: 'Ada', age: 36 }, null, 2) },
    ],
  },
]);

/** The default layout every seed opens with. */
export const PROJECT_LAYOUT = Object.freeze({ mode: 'classic', ratio: 0.5, autorun: true });

/** The gallery cards the pen bar shows (opening one replaces the project,
 * CodePen "New Pen" style). */
export const PROJECT_TEMPLATE_CARDS = PROJECT_TEMPLATES.map((t) => ({
  id: t.id, title: t.title, lead: t.lead,
}));

/** The kinds a user may add a fresh file of, each with a minimal-VALID
 * skeleton so a new file never opens on an error. (fsm/dag/model get their
 * rich editors in later orders, so they are not offered here yet.) */
export const ADDABLE_KINDS = Object.freeze(['app', 'jslt', 'query', 'state', 'data', 'schema']);

const SKELETONS = {
  app: JSON.stringify({ state: {}, view: [{ match: '$', body: ['p', {}, 'New app'] }], actions: {} }, null, 2),
  jslt: JSON.stringify({ $jslt: '0.1', rules: [{ match: '$', body: '$' }] }, null, 2),
  query: JSON.stringify({ value: '$' }, null, 2),
  state: '{}',
  data: '{}',
  schema: JSON.stringify({ type: 'object' }, null, 2),
};

/** The starter text for a freshly added file of `kind`, or null if the
 * kind is not addable. */
export function fileSkeleton(kind) {
  return Object.hasOwn(SKELETONS, kind) ? SKELETONS[kind] : null;
}

/** Materialize a template `id` into a fresh project document. */
export function projectTemplate(id) {
  const t = PROJECT_TEMPLATES.find((x) => x.id === id);
  if (t === undefined) return undefined;
  return {
    project: '0.1',
    name: t.title,
    files: t.files.map((f) => ({ ...f })),
    active: t.active,
    layout: { ...PROJECT_LAYOUT },
  };
}

/** The seed project the IDE opens with (the starter). */
export const STARTER_PROJECT = projectTemplate('starter');
