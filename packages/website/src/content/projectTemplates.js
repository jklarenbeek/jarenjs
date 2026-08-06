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
  rules: [{ match: '$', body: { greeting: { $concat: ['Hi, ', '$.name'] }, tags: '$.tags[*]' } }],
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
    title: 'Live app',
    lead: 'One application file, running live — edit the view or the state and watch the stage.',
    active: 'app.json',
    files: [{ name: 'app.json', kind: 'app', text: STARTER_APP }],
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
]);

/** The default layout every seed opens with. */
export const PROJECT_LAYOUT = Object.freeze({ mode: 'classic', ratio: 0.5, autorun: true });

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
