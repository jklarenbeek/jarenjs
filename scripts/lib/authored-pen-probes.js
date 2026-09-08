//@ts-check
/** Independent entry points whose bundles must contain only authoring machinery. */
export const AUTHORED_PEN_PROBES = {
  charts: { source: "import { bar } from '@jarenjs/linq/charts'; export const doc = bar().categories(['A']).series([{ name: 'S', values: [1] }]).schema;", maxBytes: 18000 },
  project: { source: "import { defineProject, jsonFile } from '@jarenjs/linq/project'; export const doc = defineProject([jsonFile('data', 'data', [1])]).active('data').schema;", maxBytes: 18000 },
  jtlt: { source: "import { stylesheet, rule, query } from '@jarenjs/linq/jtlt'; export const doc = stylesheet([rule([query(v => v.get('name'))], { match: '$' })]).schema;", maxBytes: 23000 },
  messages: { source: "import { catalog } from '@jarenjs/linq/messages'; export const doc = catalog('forms').entry('form/required', 'Required').partial();", maxBytes: 23000 },
  ai: { source: "import { program } from '@jarenjs/linq/ai'; export const doc = program(['data']).select('data', 'x', v => v.get('n').add(1)).answer('x').schema;", maxBytes: 20000 },
};
