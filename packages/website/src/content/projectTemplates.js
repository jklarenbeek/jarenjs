//@ts-check
/**
 * Seed projects for the Project IDE (`#/project`). Each is a `jaren-project`
 * — a small tree of typed files — that opens as "New Pen" would: the same
 * document the human edits and an AI authors. The starter is one live
 * `app`; the app seeds (form / dashboard / mini-site) are the Studio's
 * boot-tested application documents as single-`app`-file projects; the
 * others show the multi-file split (a `query`/`jslt` transform beside the
 * `data` it runs on), including a host-registered operator (`$npv`) that
 * only validates because each file is checked on its OWN boundary with
 * the operator packs mounted.
 */

import { STUDIO_TEMPLATES } from './appTemplates.js';

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

/** The default layout every seed opens with. */
export const PROJECT_LAYOUT = Object.freeze({ mode: 'classic', ratio: 0.5, autorun: true });

/**
 * One `@jarenjs/app` document as a single-`app`-file project — how a
 * studio document (a saved experiment, an inbound share, an AI write)
 * lands on the project machine.
 * @param {any} doc - a jaren-app document
 * @param {string} [name]
 */
export function singleAppProject(doc, name = 'Studio app') {
  return {
    project: '0.1',
    name,
    files: [{ name: 'app.json', kind: 'app', text: JSON.stringify(doc, null, 2) }],
    active: 'app.json',
    layout: { ...PROJECT_LAYOUT },
  };
}

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
  // the Studio's complete application documents, each a one-app project
  ...STUDIO_TEMPLATES.map((t) => {
    const { files, active } = singleAppProject(t.doc);
    return { id: t.name, title: t.title, lead: t.lead, active, files };
  }),
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

/** The gallery cards the pen bar shows (opening one replaces the project,
 * CodePen "New Pen" style). */
export const PROJECT_TEMPLATE_CARDS = PROJECT_TEMPLATES.map((t) => ({
  id: t.id, title: t.title, lead: t.lead,
}));

/** The starter text for each addable kind — minimal but VALID, so a new
 * file never opens on an error. `fsm`/`dag`/`model` are absent because
 * they have no editor or runner in the IDE yet: offering one would create
 * a file nothing can open (tracked in ROADMAP.md). */
const SKELETONS = {
  app: JSON.stringify({ state: {}, view: [{ match: '$', body: ['p', {}, 'New app'] }], actions: {} }, null, 2),
  jslt: JSON.stringify({ $jslt: '0.1', rules: [{ match: '$', body: '$' }] }, null, 2),
  query: JSON.stringify({ value: '$' }, null, 2),
  state: '{}',
  data: '{}',
  schema: JSON.stringify({ type: 'object' }, null, 2),
  contract: JSON.stringify({
    $contract: '0.1',
    operations: {
      'echo.say': {
        kind: 'command',
        input: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } },
        output: true,
      },
    },
  }, null, 2),
};

/** The kinds a user may add a fresh file of. DERIVED from the skeleton
 * table rather than written twice: a kind with no skeleton makes
 * `project-add` bail silently, so a hand-maintained second list drifts
 * into a menu entry that does nothing. The studio component's own
 * `<select>` is the third copy and cannot import this one (it is a
 * published package); `test/website/project.test.js` pins them equal. */
export const ADDABLE_KINDS = Object.freeze(Object.keys(SKELETONS));

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

/**
 * An inbound share snapshot → an openable project, or null for a foreign
 * shape. Two codecs open here: `{ e: 'project', i: { project } }` (a whole
 * project) and the Studio's `{ e: 'studio', i: { doc } }` (a single app
 * document — it opens as a one-app project, so old links keep restoring
 * what they always restored).
 * @param {any} snapshot - a decoded share token
 */
export function sharedProject(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object') return null;
  if (snapshot.e === 'studio') {
    const doc = snapshot.i?.doc;
    return doc !== null && typeof doc === 'object' ? singleAppProject(doc, 'Shared app') : null;
  }
  if (snapshot.e !== 'project') return null;
  const p = snapshot.i?.project;
  if (p === null || typeof p !== 'object' || !Array.isArray(p.files)) return null;
  const files = p.files
    .filter((f) => f !== null && typeof f === 'object')
    .map((f) => ({ name: String(f.name ?? ''), kind: String(f.kind ?? 'data'), text: String(f.text ?? '') }))
    .filter((f) => f.name !== '');
  if (files.length === 0) return null;
  return {
    project: typeof p.project === 'string' ? p.project : '0.1',
    name: typeof p.name === 'string' ? p.name : 'Shared project',
    files,
    active: files.some((f) => f.name === p.active) ? p.active : files[0].name,
    layout: { ...PROJECT_LAYOUT, ...(p.layout !== null && typeof p.layout === 'object' ? p.layout : {}) },
  };
}
