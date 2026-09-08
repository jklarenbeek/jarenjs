import { program, from, chunk, stat, answer, map, reduce, type ProgramDocument } from '@jarenjs/linq/ai';
const p = program(['corpus', 'data']);
const pieces = p.chunk('corpus', 'pieces', { strategy: 'line', size: 200 });
const mapped = pieces.map('pieces', 'found', 'Extract a number');
const reduced = mapped.reduce('found', 'total', { $count: '$[*]' });
const done = reduced.answer('total', { chars: 50 });
const doc: ProgramDocument = done.schema;
from(doc).toJSON();
p.select('data', 'selected', (v) => v.get('n').add(1)).answer('selected');
p.grep('corpus', 'hits', { pattern: 'word', flags: 'im' }).peek('hits', 'meta').stat('meta', 'stats').answer('stats');
p.step(chunk('corpus', 'pieces')).step(map('pieces', 'found', 'Extract')).step(reduce('found', 'total', '$')).step(answer('total'));
p.select('data', 'data', '$').answer('data'); // an input slot may be shadowed once
// @ts-expect-error an unknown slot/result is not in scope
p.stat('missing', 'x');
// @ts-expect-error results cannot be rebound
pieces.stat('corpus', 'pieces');
// @ts-expect-error a family is not one JSON slot
pieces.select('pieces', 'x', '$');
// @ts-expect-error a family is not an answer slot
mapped.answer('found');
// @ts-expect-error reduce reads map results
pieces.reduce('pieces', 'x', '$');
// @ts-expect-error answer is terminal
done.stat('corpus', 'x');
// @ts-expect-error raw documents make no terminal-state inference
from(doc).answer('anything');
// @ts-expect-error independent step factories still check names at insertion
p.step(stat('unknown', 'x'));
// @ts-expect-error standalone factories still cannot rebind a result
pieces.step(stat('corpus', 'pieces'));
// @ts-expect-error a raw query callback cannot reference unbound externals
p.select('data', 'x', (v, external) => external.rate);
// @ts-expect-error closed chunk strategy
p.chunk('corpus', 'x', { strategy: 'word' });
// @ts-expect-error answer carries no output binding
p.step({ op: 'answer', from: 'corpus', as: 'x' });
