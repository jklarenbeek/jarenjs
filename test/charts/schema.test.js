//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JarenValidator } from '@jarenjs/validate';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, '..', '..', 'components', 'charts', 'schemas', 'chart-definition.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

/** Every fixture config the charts tests use, validated (dogfooding). */
const FIXTURES = [
  { type: 'pie', title: 'Pets', slices: [{ label: 'Dogs', value: 3 }, { label: 'Cats', value: 1 }] },
  { type: 'pie', slices: [{ label: 'x', value: 1 }] },
  { type: 'pie', title: null, slices: [] },
  { type: 'pie', title: 'Memo' },
];

describe('the chart-definition JSON Schema', function () {
  const validate = new JarenValidator().compile(schema);

  it('accepts every fixture config', function () {
    for (const config of FIXTURES) {
      assert.equal(validate(config), true,
        `schema rejected ${JSON.stringify(config)}`);
    }
  });

  it('rejects an unknown type and malformed slices', function () {
    assert.equal(validate({ type: 'sparkline' }), false);
    assert.equal(validate({}), false);
    assert.equal(validate({ type: 'pie', slices: [{ label: 'a' }] }), false);
    assert.equal(validate({ type: 'pie', slices: [{ label: 'a', value: -1 }] }), false);
  });
});
