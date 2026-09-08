import { bare, stylesheet, rule, text, query, raw, json, apply, from, type TemplateDocument } from '@jarenjs/linq/jtlt';
const r = rule([text('$literal'), query((v, x) => v.mul(x.rate), { externals: ['rate'] }), raw('$'), json({ $const: {} }), apply('$.items', 'item')], { match: '$' });
const t = stylesheet([r.mode('item').priority(1)]).output('xml');
const doc: TemplateDocument = t.schema;
from(doc).rules([r]);
bare().rule(r);
// @ts-expect-error unknown output method
t.output('html');
// @ts-expect-error body is always a segment array
rule('literal');
// @ts-expect-error scalar is not a segment
rule([42]);
// @ts-expect-error undeclared parameter
query((_v, x) => x.missing);
// @ts-expect-error mode is a literal string
apply('$', 3);
// @ts-expect-error closed rule options
rule([], { bogus: true });
