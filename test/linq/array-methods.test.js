//@ts-check
/**
 * @file An array method called on a captured member (`u.tags.includes('a')`)
 * is a coded refusal (JL0108) naming the query-language spelling, where it
 * used to be the host's `x.tags.includes is not a function`. Only a member
 * NAMED like an array method is callable for that refusal: reading it is
 * still the member, and every other capture keeps `typeof` 'object'
 * (QUERY-PEN.md §14.9).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';

import { from, LinqBuildError } from '@jarenjs/linq';
import { queryJson } from '@jarenjs/json/query';

const ROWS = [
  { id: 1, name: 'ab', tags: ['a', 'b'], items: [{ sku: 'x', qty: 1 }, { sku: 'y', qty: 0 }] },
  { id: 2, name: 'cd', tags: ['c'], items: [{ sku: 'x', qty: 2 }] },
  { id: 3, name: 'ae', tags: [], items: [] },
];

/** The array methods a reader reaches for, and the call that spells each. */
const CALLS = /** @type {[string, (x: any) => unknown][]} */ ([
  ['includes', (x) => x.tags.includes('a')],
  ['indexOf', (x) => x.tags.indexOf('a')],
  ['lastIndexOf', (x) => x.tags.lastIndexOf('a')],
  ['some', (x) => x.items.some((i) => i.qty)],
  ['every', (x) => x.items.every((i) => i.qty)],
  ['filter', (x) => x.items.filter((i) => i.qty)],
  ['find', (x) => x.items.find((i) => i.qty)],
  ['findIndex', (x) => x.items.findIndex((i) => i.qty)],
  ['findLast', (x) => x.items.findLast((i) => i.qty)],
  ['findLastIndex', (x) => x.items.findLastIndex((i) => i.qty)],
  ['map', (x) => x.items.map((i) => i.sku)],
  ['flatMap', (x) => x.items.flatMap((i) => i.sku)],
  ['reduce', (x) => x.items.reduce((a, i) => a + i.qty, 0)],
  ['reduceRight', (x) => x.items.reduceRight((a, i) => a + i.qty, 0)],
  ['forEach', (x) => x.items.forEach(() => {})],
  ['slice', (x) => x.tags.slice(1)],
  ['join', (x) => x.tags.join(',')],
  ['sort', (x) => x.tags.sort()],
  ['reverse', (x) => x.tags.reverse()],
  ['flat', (x) => x.nest.flat()],
  ['entries', (x) => x.tags.entries()],
  ['keys', (x) => x.tags.keys()],
  ['values', (x) => x.tags.values()],
  ['fill', (x) => x.tags.fill('z')],
  ['copyWithin', (x) => x.tags.copyWithin(0, 1)],
  ['push', (x) => x.tags.push('z')],
  ['pop', (x) => x.tags.pop()],
  ['shift', (x) => x.tags.shift()],
  ['unshift', (x) => x.tags.unshift('z')],
  ['splice', (x) => x.tags.splice(0, 1)],
  ['toSorted', (x) => x.tags.toSorted()],
  ['toReversed', (x) => x.tags.toReversed()],
  ['toSpliced', (x) => x.tags.toSpliced(0, 1)],
  ['with', (x) => x.tags.with(0, 'z')],
]);

/** The string methods a reader reaches for on a captured string, and the call that spells each. */
const STRING_CALLS = /** @type {[string, (x: any) => unknown][]} */ ([
  ['toUpperCase', (x) => x.name.toUpperCase()],
  ['toLowerCase', (x) => x.name.toLowerCase()],
  ['toLocaleUpperCase', (x) => x.name.toLocaleUpperCase()],
  ['toLocaleLowerCase', (x) => x.name.toLocaleLowerCase()],
  ['trim', (x) => x.name.trim()],
  ['trimStart', (x) => x.name.trimStart()],
  ['trimEnd', (x) => x.name.trimEnd()],
  ['padStart', (x) => x.name.padStart(4, '0')],
  ['padEnd', (x) => x.name.padEnd(4, '0')],
  ['split', (x) => x.name.split('')],
  ['replaceAll', (x) => x.name.replaceAll('a', 'b')],
  ['charAt', (x) => x.name.charAt(0)],
  ['match', (x) => x.name.match(/a/)],
  ['search', (x) => x.name.search('a')],
  ['localeCompare', (x) => x.name.localeCompare('b')],
  ['repeat', (x) => x.name.repeat(2)],
  ['normalize', (x) => x.name.normalize('NFC')],
]);

describe('an array method called on a captured member is a coded refusal', () => {
  it('every method a reader reaches for answers JL0108 naming itself, in a filter and in a projection', () => {
    for (const [name, call] of CALLS) {
      const refused = (/** @type {any} */ e) => e instanceof LinqBuildError && e.code === 'JL0108'
        && e.message.startsWith(`JL0108: .${name}() is a JavaScript array method, and a captured expression has none`)
        && /\.all\(\)|\.at\(i\)|orderBy|\.concat/.test(e.message);
      assert.throws(() => from(ROWS).where(call), refused, `where ${name}`);
      assert.throws(() => from(ROWS).select((x) => ({ v: call(x) })), refused, `select ${name}`);
    }
  });

  it('every string method a reader reaches for answers JL0108 naming itself as a string method', () => {
    for (const [name, call] of STRING_CALLS) {
      const refused = (/** @type {any} */ e) => e instanceof LinqBuildError && e.code === 'JL0108'
        && e.message.startsWith(`JL0108: .${name}() is a JavaScript string method, and a captured expression has none`);
      assert.throws(() => from(ROWS).where(call), refused, `where ${name}`);
      assert.throws(() => from(ROWS).select((x) => ({ v: call(x) })), refused, `select ${name}`);
    }
  });

  it('the pen document lists every method the refusal covers', () => {
    const doc = fs.readFileSync(new URL('../../packages/linq/docs/QUERY-PEN.md', import.meta.url), 'utf8');
    const section = doc.slice(doc.indexOf('### 14.9'), doc.indexOf('### 14.10'));
    const unlisted = [...CALLS, ...STRING_CALLS].map(([name]) => name).filter((name) => !section.includes(`\`${name}\``));
    assert.deepStrictEqual(unlisted, []);
  });

  it('the messages of the newer methods name spellings that answer the rows the method would have', () => {
    const message = (/** @type {(x: any) => unknown} */ call) => {
      try { from(ROWS).select(call); return 'built'; } catch (e) { return /** @type {Error} */ (e).message; }
    };
    const array = (/** @type {string} */ name) => `JL0108: .${name}() is a JavaScript array method, and a captured expression `
      + 'has none — it stands for a value the engine computes later; ';
    const string = (/** @type {string} */ name) => `JL0108: .${name}() is a JavaScript string method, and a captured expression `
      + 'has none — it stands for a value the engine computes later; ';
    assert.strictEqual(message((x) => x.nest.flat()), array('flat') + 'fan each level with .all() — x.nest.all().all() is '
      + 'every inner element, and [x.nest.all().all()] keeps them as one array value');
    assert.strictEqual(message((x) => x.tags.keys()), array('keys') + 'a capture has no iterator over an array; x.tags.all() '
      + 'fans its elements and .at(i) indexes one');
    assert.strictEqual(message((x) => x.tags.pop()), array('pop') + 'a capture reads a value and never changes one; index an '
      + 'element with .at(i) — .at(0) is the first, .at(-1) the last — and change the array where its document is written');
    assert.strictEqual(message((x) => x.tags.with(0, 'z')), array('with') + 'a capture builds no changed copy of an array; '
      + 'index an element with .at(i), or name the new array\'s elements in the projection ([x.a, x.b])');
    assert.strictEqual(message((x) => x.tags.toSorted()), array('toSorted') + 'order the rows with the chain\'s orderBy(); a '
      + 'capture never reorders a member');
    assert.strictEqual(message((x) => x.name.slice(1)), array('slice') + 'index one element with .at(i); a capture has no '
      + 'sub-array (on a string member, .substring(start, length) is the part from a 0-based start)');
    assert.strictEqual(message((x) => x.name.toUpperCase()), string('toUpperCase') + 'the capture\'s own .upper() is the '
      + 'upper-case value');
    assert.strictEqual(message((x) => x.name.toLowerCase()), string('toLowerCase') + 'the capture\'s own .lower() is the '
      + 'lower-case value');
    assert.strictEqual(message((x) => x.name.replaceAll('.', '-')), string('replaceAll') + 'the capture\'s own '
      + '.replace(pattern, replacement) replaces every match — its pattern is an I-Regexp, so a literal . is written \\.');
    assert.strictEqual(message((x) => x.name.charAt(1)), string('charAt') + '.substring(i, 1) is the character at the '
      + '0-based index i');
    assert.strictEqual(message((x) => x.name.match(/a/)), string('match') + '.matches(pattern) tests the whole value against '
      + 'an I-Regexp pattern (x.name.matches(\'a.*\') holds when it starts with a), and .contains(v) tests for a part');
    assert.strictEqual(message((x) => x.name.localeCompare('b')), string('localeCompare') + '.lt(v), .eq(v) and .gt(v) '
      + 'compare two strings');
    assert.strictEqual(message((x) => x.name.split(',')), string('split') + 'a capture has no split; store the parts as an '
      + 'array member and fan it with .all(), or split the value in JavaScript after the chain runs');
    assert.strictEqual(message((x) => x.name.trim()), string('trim') + 'a capture has no such operator; compute it in '
      + 'JavaScript over the finished rows');

    const rows = [{ name: 'a.b', tags: ['a', 'b', 'c'], nest: [['a'], ['b', 'c']] }];
    const run = (/** @type {(x: any) => unknown} */ pick) => from(rows).select(pick).toArray();
    assert.deepStrictEqual(run((x) => [x.nest.all().all()]), [['a', 'b', 'c']]);
    assert.deepStrictEqual(run((x) => [x.tags.at(0), x.tags.at(-1)]), [['a', 'c']]);
    assert.deepStrictEqual(run((x) => x.name.substring(2, 1)), ['b']);
    assert.deepStrictEqual(run((x) => x.name.substring(1, 2)), ['.b']);
    assert.deepStrictEqual(run((x) => x.name.upper()), ['A.B']);
    assert.deepStrictEqual(run((x) => x.name.replace('\\.', '-')), ['a-b']);
    assert.deepStrictEqual(run((x) => [x.name.matches('a.*'), x.name.matches('b'), x.name.contains('b')]), [[true, false, true]]);
    assert.deepStrictEqual(run((x) => [x.name.lt('b'), x.name.gt('b')]), [[true, false]]);
  });

  it('a string method the capture has as its own is that method, never the refusal', () => {
    const rows = [{ name: 'a.ba' }];
    assert.deepStrictEqual(from(rows).select((x) => [x.name.startsWith('a.'), x.name.endsWith('a'), x.name.substring(2),
      x.name.replace('a', 'x'), x.name.concat('!'), x.name.length()]).toArray(), [[true, true, 'ba', 'x.bx', 'a.ba!', 4]]);
  });

  it('the message names the spelling that works, and those spellings answer the rows the method would have', () => {
    assert.throws(() => from(ROWS).where((x) => x.tags.includes('a')), (e) => e.message
      === 'JL0108: .includes() is a JavaScript array method, and a captured expression has none — it stands for a value '
      + 'the engine computes later; test the elements with a fanned comparison — x.tags.all().eq(v) holds when any element '
      + 'equals v (on a string member, x.name.contains(v)); for a scalar in a list write v.in([a, b]) or v.in(x.tags)');
    assert.deepStrictEqual(from(ROWS).where((x) => x.tags.all().eq('a')).select((x) => x.id).toArray(), [1]);
    assert.deepStrictEqual(from(ROWS).where((x) => x.name.contains('a')).select((x) => x.id).toArray(), [1, 3]);
    assert.deepStrictEqual(from(ROWS).where((x) => x.items.all().qty.eq(0)).select((x) => x.id).toArray(), [1]);
    // every(i => i.qty === 0): no element differs from 0 (an empty array holds vacuously, as in JavaScript)
    assert.deepStrictEqual(from(ROWS).where((x) => x.items.all().qty.ne(0).not()).select((x) => x.id).toArray(), [3]);
    assert.deepStrictEqual(from(ROWS).select((x) => x.items.all().qty.sum()).toArray(), [1, 2, 0]);
    assert.deepStrictEqual(from(ROWS).select((x) => [x.items.all().sku]).toArray(), [['x', 'y'], ['x'], []]);
  });

  it('a member read of such a name is still the member: an expression every consumer accepts', () => {
    const rows = [{ id: 1, filter: 'f', map: 1, find: ['k'] }, { id: 2, filter: 'g', map: 2, find: [] }];
    assert.deepStrictEqual(from(rows).where((x) => x.filter.eq('f')).select((x) => x.id).toArray(), [1]);
    assert.deepStrictEqual(from(rows).select((x) => ({ f: x.filter, m: x.map.add(1) })).toArray(),
      [{ f: 'f', m: 2 }, { f: 'g', m: 3 }]);
    assert.deepStrictEqual(from(rows).where((x) => x.id.in(x.find.all())).toArray(), []);
    assert.deepStrictEqual(from(rows).where((x) => x.map.in(x.find)).toArray(), []);
    assert.deepStrictEqual(from(rows).where((x) => x.filter.exists()).select((x) => x.id).toArray(), [1, 2]);
    assert.deepStrictEqual(from(rows).select((x) => [x.filter, x.map]).toArray(), [['f', 1], ['g', 2]]);
    assert.deepStrictEqual(from(rows).select((x) => x.find.all()).toDocument().$return, '$it.find[*]');
    // an operator result's member read takes the same path, and so does its call
    assert.throws(() => from(rows).where((x) => x.map.add(1).includes(2)),
      (e) => e instanceof LinqBuildError && e.code === 'JL0108' && /^JL0108: \.includes\(\)/.test(e.message));
    assert.deepStrictEqual(from(rows).select((x) => x.map.add(1).filter).toDocument().$return,
      { $get: [{ $add: ['$it.map', 1] }, 'filter'] });
  });

  it('only a member named like an array method is callable: typeof of every other capture is unchanged', () => {
    let types = /** @type {string[]} */ ([]);
    from(ROWS).select((x, p) => {
      types = [x, x.tags, x.tags.all(), x.tags.at(0), x.name.upper(), x.get('filter'), x.get('includes'), p].map((v) => typeof v);
      // the inherited names are plain members, not array methods
      types.push(typeof x.includes, typeof x.tags.map, typeof x.toString, typeof x.constructor);
      return x.id;
    });
    assert.deepStrictEqual(types, ['object', 'object', 'object', 'object', 'object', 'object', 'object', 'object', 'function', 'function', 'object', 'object']);
  });

  it('every other operation on such a member behaves as on any member: spread, keys, new', () => {
    const rows = [{ id: 1, map: 1, tags: ['a'] }];
    // a spread of a capture is a coded refusal, for a callable member too (not a silent {})
    const spread = [(/** @type {any} */ x) => x.tags, (/** @type {any} */ x) => x.map].map((pick) => {
      try { from(rows).select((x) => ({ ...pick(x) })); return 'built'; }
      catch (e) { return e.message; }
    });
    assert.strictEqual(spread[0], 'JL0005: a captured expression cannot embed a function value');
    assert.strictEqual(spread[1], spread[0]);
    let keys = /** @type {string[][]} */ ([]);
    from(rows).select((x) => { keys = [Object.keys(x.tags), Object.keys(x.map)]; return x.id; });
    assert.deepStrictEqual(keys[1], keys[0]);
    assert.strictEqual(keys[0].length > 0, true);
    // `new` on the call position is the same coded refusal as the call
    assert.throws(() => from(rows).select((x) => new x.tags.map()),
      (e) => e instanceof LinqBuildError && e.code === 'JL0108' && /^JL0108: \.map\(\) is a JavaScript array method/.test(e.message));
    let stolen = /** @type {any} */ (undefined);
    from(rows).select((x) => { stolen = x.tags.map; return x.id; });
    assert.throws(() => new stolen(), (e) => e instanceof LinqBuildError && e.code === 'JL0002');
  });

  it('get() reads a member of that name explicitly and stays a plain, uncallable member', () => {
    const rows = [{ includes: 5 }];
    assert.deepStrictEqual(from(rows).select((x) => x.get('includes').add(1)).toArray(), [6]);
    assert.throws(() => from(rows).select((x) => x.get('includes')('a')),
      (e) => e instanceof TypeError && !(e instanceof LinqBuildError));
  });

  it('a name that is an operator method is that method, never the refusal', () => {
    assert.deepStrictEqual(from(ROWS).select((x) => x.tags.at(0)).toArray(), ['a', 'c']);
    assert.deepStrictEqual(from(ROWS).select((x) => x.name.concat('!')).toArray(), ['ab!', 'cd!', 'ae!']);
  });

  it('a stolen callable member is JL0002 when called after its capture', () => {
    let stolen = /** @type {any} */ (undefined);
    from([]).where((x) => { stolen = x.tags.includes; return x.n.gt(0); });
    assert.throws(() => stolen('a'), (e) => e instanceof LinqBuildError && e.code === 'JL0002');
  });
});

describe('a member of a relation hop is refused the same way', () => {
  const TABLES = Object.freeze({
    Post: Object.freeze({
      author: Object.freeze({ to: 'User', kind: 'oneToOne', via: 'authorId', fkEntity: 'Post', fkTargets: 'User', targetKey: 'id' }),
    }),
    User: Object.freeze({}),
  });
  const ROOT = {
    User: [{ id: 'u1', tags: ['a'], filter: 'k' }],
    Post: [{ pid: 1, authorId: 'u1' }],
  };
  const posts = () => from({
    root: '$.Post[*]',
    scope: { relations: TABLES },
    relations: TABLES.Post,
    execute: (/** @type {any} */ document, /** @type {any} */ options) => queryJson(document, structuredClone(ROOT), options.externals),
  });

  it('p.author.tags.includes(v) is JL0108; reading p.author.filter is the member', () => {
    assert.throws(() => posts().where((p) => p.author.tags.includes('a')),
      (e) => e instanceof LinqBuildError && e.code === 'JL0108' && /^JL0108: \.includes\(\)/.test(e.message));
    assert.throws(() => posts().select((p) => ({ v: p.author.tags.map((t) => t) })),
      (e) => e.code === 'JL0108' && /^JL0108: \.map\(\)/.test(e.message));
    assert.deepStrictEqual(posts().select((p) => p.author.filter).toArray(), ['k']);
    // the message names the spellings it names on a path member, and both run off a relation target
    assert.throws(() => posts().where((p) => p.author.tags.includes('a')),
      (e) => e.message === 'JL0108: .includes() is a JavaScript array method, and a captured expression has none — it stands '
        + 'for a value the engine computes later; test the elements with a fanned comparison — x.tags.all().eq(v) holds when '
        + 'any element equals v (on a string member, x.name.contains(v)); for a scalar in a list write v.in([a, b]) or v.in(x.tags)');
    assert.deepStrictEqual(posts().where((p) => p.author.tags.all().eq('a')).select((p) => p.pid).toArray(), [1]);
    assert.deepStrictEqual(posts().where((p) => p.author.filter.in(p.author.tags)).select((p) => p.pid).toArray(), []);
    assert.deepStrictEqual(posts().where((p) => p.author.tags.at(0).in(p.author.tags)).select((p) => p.pid).toArray(), [1]);
    assert.deepStrictEqual(posts().where((p) => p.author.tags.at(0).eq('a')).select((p) => p.pid).toArray(), [1]);
    assert.deepStrictEqual(posts().where((p) => p.author.tags.at(0).eq('zz')).select((p) => p.pid).toArray(), []);
  });
});

describe('an array method on a to-many relation names the predicate spelling', () => {
  const TABLES = Object.freeze({
    User: Object.freeze({
      posts: Object.freeze({ to: 'Post', kind: 'oneToMany', via: 'authorId', fkEntity: 'Post', fkTargets: 'User', targetKey: 'id' }),
    }),
    Post: Object.freeze({}),
  });
  const ROOT = {
    User: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }],
    Post: [
      { pid: 1, authorId: 'u1', published: true, qty: 2 },
      { pid: 2, authorId: 'u1', published: false, qty: 3 },
      { pid: 3, authorId: 'u2', published: true, qty: 1 },
    ],
  };
  const users = () => from({
    root: '$.User[*]',
    scope: { relations: TABLES },
    relations: TABLES.User,
    execute: (/** @type {any} */ document, /** @type {any} */ options) => queryJson(document, structuredClone(ROOT), options.externals),
  });
  /** @param {(u: any) => unknown} pick */
  const message = (pick) => {
    try { users().where(pick); return 'built'; } catch (e) { return `${/** @type {any} */ (e).code} ${/** @type {Error} */ (e).message}`; }
  };

  it('u.posts.some(…) names the fanned comparison, and keeps the member read of the fan', () => {
    assert.strictEqual(message((u) => u.posts.some((/** @type {any} */ p) => p.published)),
      'JL0005 JL0005: .some is read off a to-many relation, which holds an array of related rows, and .some() is a '
      + 'JavaScript array method a captured expression does not have — fan the related rows with .all() and spell it as on '
      + 'an array member: a capture has no per-element predicate; compare a fanned member instead — '
      + 'x.items.all().sku.eq(v) holds when any element\'s sku equals v, x.items.all().qty.ne(0).not() when none differs '
      + 'from 0 — or index one with .at(i) (a member named some of each related row is .all().some)');
    for (const [name, spelling] of [['filter', 'compare a fanned member'], ['every', 'compare a fanned member'],
      ['map', 'name the member of each element off the fan'], ['reduce', 'aggregate the fanned member'],
      ['includes', 'test the elements with a fanned comparison'], ['sort', 'orderBy()'], ['keys', 'a capture has no iterator']]) {
      const said = message((u) => u.posts[name]());
      assert.ok(said.startsWith(`JL0005 JL0005: .${name} is read off a to-many relation, which holds an array of related rows, `
        + `and .${name}() is a JavaScript array method`) && said.includes(spelling)
        && said.endsWith(`(a member named ${name} of each related row is .all().${name})`), said);
    }
  });

  it('a member that is no array method keeps its message, a string method name too', () => {
    const fanFirst = (/** @type {string} */ name) => `JL0005 JL0005: .${name} is read off a to-many relation, which holds `
      + `an array of related rows — fan them first (.all().${name}), index one (.at(0)), or aggregate the array`;
    assert.strictEqual(message((u) => u.posts.title), fanFirst('title'));
    assert.strictEqual(message((u) => u.posts.trim()), fanFirst('trim'));
  });

  it('the spellings the message names answer the rows the array method would have', () => {
    const ids = (/** @type {any} */ chain) => chain.select((/** @type {any} */ u) => u.id).toArray();
    // some(p => p.published)
    assert.deepStrictEqual(ids(users().where((u) => u.posts.all().published.eq(true))), ['u1', 'u2']);
    // every(p => p.published): no related row differs (a user with none holds vacuously)
    assert.deepStrictEqual(ids(users().where((u) => u.posts.all().published.ne(true).not())), ['u2', 'u3']);
    // map(p => p.pid), reduce((a, p) => a + p.qty, 0), and one row by index
    assert.deepStrictEqual(users().select((u) => [u.posts.all().pid]).toArray(), [[1, 2], [3], []]);
    assert.deepStrictEqual(users().select((u) => u.posts.all().qty.sum()).toArray(), [5, 1, 0]);
    assert.deepStrictEqual(users().select((u) => u.posts.at(0).pid).toArray(), [1, 3]);
    // includes(v) over a member of the related rows: a scalar in the fanned member
    assert.deepStrictEqual(ids(users().where((u) => u.id.in(u.posts.all().authorId))), ['u1', 'u2']);
  });
});
