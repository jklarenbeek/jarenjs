import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, throws } from 'node:assert';

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { compileNormalizer } from '@jarenjs/validate/normalize';
import { JarenValidator } from '@jarenjs/validate';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

// A model's tool call arrives as JSON, but a member the schema declares as an
// object or an array often arrives as that structure's JSON TEXT: one quoted
// string. `coerceJsonText` decodes such a string where the schema refuses a
// string there, and leaves every other string alone.
const ON = { coerceJsonText: true };
const text = (value) => JSON.stringify(value);

/** Normalize `input` and assert the result is unchanged by a second pass. */
const once = (normalize, input) => {
  const out = normalize(input);
  strictEqual(normalize(out), out, 'a second pass changes nothing');
  return out;
};

describe('coerceJsonText — decodes JSON text where the schema wants a container', () => {
  it('decodes a property, then normalizes inside what it decoded', () => {
    const schema = {
      type: 'object',
      properties: { args: { type: 'object', properties: { inner: { type: 'object' }, n: { type: 'integer' } } } },
    };
    const normalize = compileNormalizer(schema, { ...ON, coerceTypes: true });
    const input = { args: text({ inner: text({ x: 1 }), n: '7' }) };
    deepStrictEqual(once(normalize, input), { args: { inner: { x: 1 }, n: 7 } });
  });

  it('decodes array items and keeps an untouched item by reference', () => {
    const kept = { b: 2 };
    const out = once(compileNormalizer({ type: 'array', items: { type: 'object' } }, ON), ['{"a":1}', kept]);
    deepStrictEqual(out, [{ a: 1 }, { b: 2 }]);
    strictEqual(out[1], kept);
  });

  it('decodes a prefixItems position by that position\'s own schema', () => {
    const schema = { type: 'array', prefixItems: [{ type: 'array' }, { type: 'string' }] };
    deepStrictEqual(once(compileNormalizer(schema, ON), ['[1,2]', '[3]']), [[1, 2], '[3]']);
  });

  it('decodes additionalProperties and patternProperties members', () => {
    const schema = {
      type: 'object',
      patternProperties: { '^x-': { type: 'object' } },
      additionalProperties: { type: 'array', items: { type: 'integer' } },
    };
    const normalize = compileNormalizer(schema, { ...ON, coerceTypes: true });
    deepStrictEqual(once(normalize, { 'x-a': '{}', list: '["1",2]' }), { 'x-a': {}, list: [1, 2] });
  });

  it('decodes behind a $ref, recursively', () => {
    const schema = {
      $defs: { Node: { type: 'object', properties: { children: { type: 'array', items: { $ref: '#/$defs/Node' } } } } },
      $ref: '#/$defs/Node',
    };
    const input = text({ children: [text({ children: [] }), { children: text([text({})]) }] });
    deepStrictEqual(once(compileNormalizer(schema, ON), input), { children: [{ children: [] }, { children: [{}] }] });
  });

  it('decodes where an allOf branch wants an object', () => {
    const schema = { allOf: [{ type: 'object', properties: { a: { type: 'integer' } } }] };
    deepStrictEqual(once(compileNormalizer(schema, { ...ON, coerceTypes: true }), '{"a":"1"}'), { a: 1 });
  });

  it('decodes the root, and accepts JSON whitespace around the text', () => {
    deepStrictEqual(once(compileNormalizer({ type: 'object' }, ON), ' \n\t{"a":1}\r\n'), { a: 1 });
  });

  it('decodes a nullable container (the strict-profile spelling) and leaves the text null', () => {
    const normalize = compileNormalizer({ type: ['object', 'null'] }, ON);
    deepStrictEqual(once(normalize, '{"a":1}'), { a: 1 });
    strictEqual(once(normalize, 'null'), 'null');
    strictEqual(normalize(null), null);
  });

  it('runs defaults, stripping and coercion inside the decoded value', () => {
    const schema = {
      type: 'object',
      properties: {
        cfg: {
          type: 'object',
          properties: { port: { type: 'integer', default: 8080 }, host: { type: 'string' } },
          additionalProperties: false,
        },
      },
    };
    const normalize = compileNormalizer(schema, { ...ON, useDefaults: true, removeAdditional: true, coerceTypes: true, trimStrings: true });
    deepStrictEqual(once(normalize, { cfg: '{"port":" 9000 ","stray":1,"host":" h "}' }), { cfg: { port: 9000, host: 'h' } });
    deepStrictEqual(once(normalize, { cfg: '{}' }), { cfg: { port: 8080 } });
  });

  it('reads the trimmed text where trimStrings applies, so one pass is enough', () => {
    const normalize = compileNormalizer({ type: 'object' }, { ...ON, trimStrings: true });
    for (const input of ['\u00a0{"a":1}', '{"a":1}\u00a0', '\ufeff{"a":1}', '\u2028[1]'])
      deepStrictEqual(once(normalize, input), input.includes('[') ? '[1]' : { a: 1 });
    strictEqual(compileNormalizer({ type: 'object' }, ON)('\u00a0{"a":1}'), '\u00a0{"a":1}');
  });

  it('takes a predicate, decided per schema node', () => {
    const schema = {
      type: 'object',
      properties: { a: { type: 'object', 'x-json': true }, b: { type: 'object' } },
    };
    const normalize = compileNormalizer(schema, { coerceJsonText: (node) => node['x-json'] === true });
    deepStrictEqual(once(normalize, { a: '{}', b: '{}' }), { a: {}, b: '{}' });
  });

  it('keeps a decoded __proto__ member as an own member', () => {
    const out = compileNormalizer({ type: 'object' }, ON)('{"__proto__":{"x":1}}');
    strictEqual(Object.getPrototypeOf(out), Object.prototype);
    strictEqual(Object.hasOwn(out, '__proto__'), true);
    deepStrictEqual(Object.keys(out), ['__proto__']);
  });

  it('never mutates the input', () => {
    const input = Object.freeze({ args: '{"a":[1]}', list: Object.freeze(['[2]']) });
    const schema = { type: 'object', properties: { args: { type: 'object' }, list: { type: 'array', items: { type: 'array' } } } };
    deepStrictEqual(once(compileNormalizer(schema, ON), input), { args: { a: [1] }, list: [[2]] });
    deepStrictEqual(input, { args: '{"a":[1]}', list: ['[2]'] });
  });
});

describe('coerceJsonText — leaves a string the schema could mean as a string', () => {
  const stays = (schema, input) => {
    const normalize = compileNormalizer(schema, { ...ON, coerceTypes: true });
    strictEqual(normalize(input), input);
  };

  it('never decodes where the type admits a string', () => {
    stays({ type: ['string', 'object'] }, '{"a":1}');
    stays({ type: 'string' }, '[1]');
  });

  it('never decodes where no type is declared (a string is valid there)', () => {
    stays({ properties: { a: { type: 'integer' } } }, '{"a":1}');
    stays({ items: { type: 'integer' } }, '[1]');
  });

  it('never decodes inside anyOf or oneOf: the normalizer does not pick a branch', () => {
    stays({ anyOf: [{ type: 'string' }, { type: 'object' }] }, '{"a":1}');
    stays({ oneOf: [{ type: 'object' }, { type: 'array' }] }, '{"a":1}');
  });

  it('never reads a $ref\'s sibling type where the validator ignores $ref siblings', () => {
    const schema = { $defs: { S: { type: 'string' } }, $ref: '#/$defs/S', type: 'object' };
    stays(schema, '{"a":1}');
    strictEqual(new JarenValidator().compile(schema)('{"a":1}'), true);
    stays({ $schema: 'http://json-schema.org/draft-07/schema#', definitions: { A: {} }, $ref: '#/definitions/A', type: 'object' }, '{"a":1}');
  });

  it('decodes nothing in a $ref\'s inert siblings: allOf branches and member schemas', () => {
    const branch = { $defs: { S: { type: 'string' } }, $ref: '#/$defs/S', allOf: [{ type: 'object' }] };
    const member = { $defs: { T: { properties: { a: { type: 'string' } } } }, $ref: '#/$defs/T', properties: { a: { type: 'object' } } };
    const draft07 = (schema) => ({ $schema: 'http://json-schema.org/draft-07/schema#', ...schema });
    for (const [schema, input] of [[branch, '{"a":1}'], [member, { a: '{"x":1}' }], [draft07(branch), '{"a":1}'], [draft07(member), { a: '{"x":1}' }]]) {
      stays(schema, input);
      strictEqual(new JarenValidator().compile(schema)(input), true);
    }
    // One target reached both beside an inert $ref and directly decodes only directly.
    const shared = {
      $defs: { A: {}, O: { type: 'object' } },
      type: 'object',
      properties: {
        inert: { $ref: '#/$defs/A', properties: { x: { $ref: '#/$defs/O' } } },
        plain: { properties: { x: { $ref: '#/$defs/O' } } },
      },
    };
    const input = { inert: { x: '{"a":1}' }, plain: { x: '{"a":1}' } };
    deepStrictEqual(compileNormalizer(shared, ON)(input), { inert: { x: '{"a":1}' }, plain: { x: { a: 1 } } });
    const asserted = { $schema: 'https://json-schema.org/draft/2020-12/schema', ...member, $defs: { T: {} } };
    deepStrictEqual(compileNormalizer(asserted, ON)({ a: '{"x":1}' }), { a: { x: 1 } });
  });

  it('reads a $ref\'s sibling type in a draft that asserts it', () => {
    const schema = { $schema: 'https://json-schema.org/draft/2020-12/schema', $defs: { A: {} }, $ref: '#/$defs/A', type: 'object' };
    deepStrictEqual(compileNormalizer(schema, ON)('{"a":1}'), { a: 1 });
    const draft2019 = { ...schema, $schema: 'https://json-schema.org/draft/2019-09/schema' };
    deepStrictEqual(compileNormalizer(draft2019, ON)('{"a":1}'), { a: 1 });
  });

  it('leaves text that is not JSON, so validation reports the string', () => {
    for (const input of ['{a:1}', '{"a":1', '{"a":1}}', '', '   ', '{ }'])
      stays({ type: 'object' }, input);
  });

  it('leaves JSON text of a scalar, including a quoted JSON text', () => {
    stays({ type: ['object', 'number'] }, '42');
    stays({ type: ['array', 'boolean'] }, 'true');
    stays({ type: 'object' }, text(text({ a: 1 })));
  });

  it('leaves JSON text of the other container kind', () => {
    stays({ type: 'object' }, '[1]');
    stays({ type: 'array' }, '{"a":1}');
  });

  it('is off unless asked for, alone or beside every other option', () => {
    const schema = { type: 'object', properties: { a: { type: 'object' } } };
    const input = { a: '{}' };
    strictEqual(compileNormalizer(schema)(input), input);
    strictEqual(compileNormalizer(schema, { useDefaults: true, removeAdditional: 'all', coerceTypes: true, trimStrings: true })(input), input);
    strictEqual(compileNormalizer(schema, { coerceJsonText: false })(input), input);
  });
});

describe('coerceJsonText — validation still judges what it decoded', () => {
  it('reports a decoded value the schema refuses at its own instance path', () => {
    const schema = {
      type: 'object',
      properties: { args: { type: 'object', properties: { x: { type: 'integer' } }, required: ['x'] } },
    };
    const validate = new JarenValidator({ collectErrors: true }).compile(schema);
    const shaped = compileNormalizer(schema, ON)({ args: '{"y":1}' });
    deepStrictEqual(shaped, { args: { y: 1 } });
    const result = validate(shaped);
    strictEqual(result.valid, false);
    deepStrictEqual(result.errors.map((e) => [e.keyword, e.instancePath]), [['required', '/args']]);
  });

  it('leaves an undecodable string for validation to report as the wrong type', () => {
    const schema = { type: 'object', properties: { args: { type: 'object' } } };
    const validate = new JarenValidator({ collectErrors: true }).compile(schema);
    const result = validate(compileNormalizer(schema, ON)({ args: '{oops}' }));
    deepStrictEqual(result.errors.map((e) => [e.keyword, e.instancePath]), [['type', '/args']]);
  });
});

describe('coerceJsonText — a closed option', () => {
  it('refuses a value that is not a boolean or a predicate', () => {
    throws(() => compileNormalizer({}, { coerceJsonText: 'yes' }), {
      name: 'TypeError',
      message: "compileNormalizer: 'coerceJsonText' must be true, false or a function of the schema node",
    });
  });

  it('names itself as the nearest member of a misspelling', () => {
    throws(() => compileNormalizer({}, { coerceJsonTxt: true }), {
      name: 'TypeError',
      message: "compileNormalizer: unknown option 'coerceJsonTxt' — did you mean 'coerceJsonText'?",
    });
  });
});

describe('coerceJsonText — the README example', () => {
  it('runs as written: a double-encoded tool call repaired, then validated', () => {
    const readme = readFileSync(new URL('../../packages/validate/README.md', import.meta.url), 'utf8');
    const section = readme.slice(readme.indexOf('### Structure sent as JSON text'));
    const start = section.indexOf('```js\n') + 6;
    const fence = section.slice(start, section.indexOf('\n```', start));
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', fence], { cwd: ROOT, encoding: 'utf8' });
    strictEqual(out, 'false\n{"query":"jaren","filter":{"tags":["json","schema"],"limit":10}} true\n');
  });
});
