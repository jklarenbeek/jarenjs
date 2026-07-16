import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFile } from 'node:fs/promises';

import {
  compileJSONPointer,
  compileRelativeJSONPointer,
  JSONPOINTER_NOTHING,
  compileJSONPath,
  compileJsonQuery,
  queryJson,
} from '@jarenjs/json';
import { compileXQuery } from '@jarenjs/json/xquery';
import { JarenValidator } from '@jarenjs/validate';

// Every code example in packages/json/README.md runs here, verbatim where
// the example is self-contained, with the README's implied context (the
// RFC 9535 bookstore plus the ratings array) supplied once below. When a
// README example changes, this file must change with it - the README's
// claims are assertions, not prose.

const data = {
  store: {
    book: [
      { category: 'reference', author: 'Nigel Rees', title: 'Sayings of the Century', price: 8.95 },
      { category: 'fiction', author: 'Evelyn Waugh', title: 'Sword of Honour', price: 12.99 },
      { category: 'fiction', author: 'Herman Melville', title: 'Moby Dick', isbn: '0-553-21311-3', price: 8.99 },
      { category: 'fiction', author: 'J. R. R. Tolkien', title: 'The Lord of the Rings', isbn: '0-395-19395-8', price: 22.99 },
    ],
    bicycle: { color: 'red', price: 399 },
  },
  ratings: [
    { isbn: '0-395-19395-8', stars: 5 },
    { isbn: '0-553-21311-3', stars: 4 },
    { isbn: '0-000-00000-0', stars: 1 },
  ],
};

describe('README examples: JSON Pointer', () => {
  it('resolves pointers and relative pointers as documented', () => {
    const doc = { limits: { min: 2, max: 9 }, value: 5 };

    const getMin = compileJSONPointer('/limits/min');
    assert.strictEqual(getMin(doc), 2);
    assert.strictEqual(getMin({}), JSONPOINTER_NOTHING);

    const getLimits = compileRelativeJSONPointer('1/limits');
    assert.deepStrictEqual(getLimits(doc, '/value'), { min: 2, max: 9 });

    const getName = compileRelativeJSONPointer('0#');
    assert.strictEqual(getName(doc, '/limits/min'), 'min');
  });
});

describe('README examples: the JSONPath compiler', () => {
  it('compiles once and runs on any document', () => {
    const query = compileJSONPath('$.store.book[?@.price < 10].title');

    assert.deepStrictEqual(query(data), ['Sayings of the Century', 'Moby Dick']);

    const other = { store: { book: [{ title: 'Cheap', price: 1 }] } };
    assert.deepStrictEqual(query(other), ['Cheap']);
  });
});

describe('README examples: the Jaren JSON Query language', () => {
  it('runs the opening filter + project example', () => {
    const query = compileJsonQuery({
      $for: { b: '$.store.book[*]' },
      $where: { $lt: ['$b.price', 10] },
      $orderby: '$b.price',
      $return: { title: '$b.title', price: '$b.price' },
    });

    assert.deepStrictEqual(query(data), [
      { title: 'Sayings of the Century', price: 8.95 },
      { title: 'Moby Dick', price: 8.99 },
    ]);
  });

  it('accepts a bare JSONPath string as the degenerate query', () => {
    assert.deepStrictEqual(
      queryJson('$.store.book[?@.price < 10].title', data),
      ['Sayings of the Century', 'Moby Dick']);
  });

  it('runs the join example (spec A.3)', () => {
    assert.deepStrictEqual(
      queryJson({
        $for: { b: '$.store.book[*]', r: '$.ratings[*]' },
        $where: { $eq: ['$b.isbn', '$r.isbn'] },
        $orderby: '$b.price',
        $return: { title: '$b.title', stars: '$r.stars' },
      }, data),
      [
        { title: 'Moby Dick', stars: 4 },
        { title: 'The Lord of the Rings', stars: 5 },
      ]);
  });

  it('runs the grouping example (spec A.4)', () => {
    assert.deepStrictEqual(
      queryJson({
        $for: { b: '$.store.book[*]' },
        $groupby: { genre: '$b.category' },
        $return: { genre: '$genre', count: { $count: '$b' }, avg: { $avg: '$b.price' } },
      }, data),
      [
        { genre: 'reference', count: 1, avg: 8.95 },
        { genre: 'fiction', count: 3, avg: 14.99 },
      ]);
  });

  it('collects and binds external parameters', () => {
    const cheaper = compileJsonQuery({
      $for: { b: '$.store.book[*]' },
      $where: { $le: ['$b.price', '$maxPrice'] },
      $return: '$b.title',
    });

    assert.deepStrictEqual([...cheaper.externals], ['maxPrice']);
    assert.deepStrictEqual(
      cheaper(data, { maxPrice: 9 }),
      ['Sayings of the Century', 'Moby Dick']);
  });
});

describe('README examples: generating queries with LLMs', () => {
  it('validates, compiles and runs a structured-output query document', async () => {
    // stand-in for the provider's structured-output call in the README;
    // returns what a schema-constrained model would emit for the prompt
    const generate = async (_prompt, _schema) => JSON.stringify({
      $for: { b: '$.store.book[*]' },
      $where: { $lt: ['$b.price', 10] },
      $groupby: { genre: '$b.category' },
      $return: { genre: '$genre', cheap: { $count: '$b' } },
    });
    const prompt = 'cheap books per genre';

    // the README pipeline, verbatim
    const schema = JSON.parse(await readFile('packages/json/schemas/jaren-query.schema.json', 'utf8'));

    const text = await generate(prompt, schema);

    const isQueryDoc = new JarenValidator().compile(schema);
    const doc = JSON.parse(text);
    if (!isQueryDoc(doc)) throw new Error('model escaped the schema');
    const query = compileJsonQuery(doc);

    assert.deepStrictEqual(query(data), [
      { genre: 'reference', cheap: 1 },
      { genre: 'fiction', cheap: 1 },
    ]);

    // ... and the validator actually rejects out-of-grammar documents
    assert.strictEqual(isQueryDoc({ $eq: [1, 2, 3] }), false);
  });
});

describe('README examples: the XQuery text front-end', () => {
  it('compiles the README query text', () => {
    const q = compileXQuery('for $b in $doc?store?book?* where $b?price lt 10 return $b?title');

    assert.deepStrictEqual(
      q(null, { doc: data }),
      ['Sayings of the Century', 'Moby Dick']);
  });
});
