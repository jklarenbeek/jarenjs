import { defineProject, file, jsonFile, from, type ProjectDocument } from '@jarenjs/linq/project';
import { number } from '@jarenjs/linq/schema';
const p = defineProject([file('data', 'data', '{}'), jsonFile('schema', 'schema', number().schema)]);
p.active('data').active('schema');
p.file(file('next', 'query', '$')).active('next');
p.files([file('only', 'data', '[]')]).active('only');
const doc: ProjectDocument = p.toJSON();
from(doc).active('dynamic');
// @ts-expect-error undeclared filename
p.active('missing');
// @ts-expect-error replacement removes former names
p.files([file('only', 'data', '[]')]).active('data');
// @ts-expect-error undeclared kind
file('x', 'unknown', '{}');
// @ts-expect-error files contain text
file('x', 'data', {});
// @ts-expect-error active is inferred in options too
defineProject([file('x', 'data', '{}')], { active: 'missing' });
// @ts-expect-error closed layout mode
p.layout({ mode: 'bottom' });
// @ts-expect-error JSON only
jsonFile('x', 'data', () => 1);

import { bar } from '@jarenjs/linq/charts';
import { stylesheet } from '@jarenjs/linq/jtlt';
jsonFile('chart', 'data', bar().schema);
jsonFile('template', 'data', stylesheet().schema);
// @ts-expect-error nested functions are not JSON
jsonFile('x', 'data', { run: () => 1 });
// @ts-expect-error bigint is not JSON
jsonFile('x', 'data', { n: 1n });

jsonFile('program', 'data', { steps: [{ op: 'answer', from: 'data' }] });
file('query', 'query', '"$"', { model: 'store', collection: 'notes', input: 'seed' });
jsonFile('app', 'app', { view: [] }, { imports: { state: 'seed' } });
// @ts-expect-error references name files with strings
file('query', 'query', '"$"', { model: 1 });
// @ts-expect-error closed routing options
file('query', 'query', '"$"', { worker: 'shared' });
