//@ts-check
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { JarenValidator } from '@jarenjs/validate';
import { parseMarkdown, mdToForm } from '@jarenjs/md';
import * as forms from '@jarenjs/forms';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.join(__dirname, '..', '..', 'components', 'md', 'schemas', 'jaren-md-ast.schema.json');
const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));

const CORPUS = [
  '# Everything *at* **once** `x`\n',
  '---\ntitle: T\ntags: [a, b]\n---\npara with [l](/u "t") and ![i](/i.png)\n',
  '> quote\n>\n> - list\n> - in quote\n',
  '- [ ] task\n- [x] done\n  - nested\n\n1. loose\n\n2. list\n',
  '| a | b |\n| :-- | --: |\n| `1` | *2* |\n',
  '```js meta\ncode();\n```\n\n    indented\n',
  '<div>\nraw html\n</div>\n\ntext <b>inline</b> html\n',
  'auto <https://x.y/> and mail <a@b.cd>\n',
  'hard  \nbreak and\nsoft\n',
  '***\n\nSetext\n======\n',
  'A claim[^1] and www.example.com and a@b.test\n\n[^1]: The source, with [^1] itself.\n',
  '[^uncited]: a definition nothing points at\n',
];

describe('the AST JSON Schema', function () {
  const validate = new JarenValidator().compile(schema);

  it('accepts every document the parser produces', function () {
    for (const src of CORPUS) {
      const doc = parseMarkdown(src);
      assert.equal(validate(doc), true,
        `schema rejected parser output for ${JSON.stringify(src)}`);
    }
  });

  it('accepts plugin/extension nodes and custom nodes', function () {
    const doc = parseMarkdown('```mermaid\ngraph\n```\n', {
      plugins: [{ name: 'mermaid', fences: ['mermaid'], node: 'mermaid' }],
    });
    assert.equal(validate(doc), true);
    assert.equal(validate({
      $md: '0.1',
      frontmatter: null,
      ast: [{ type: 'custom', name: 'callout', data: { kind: 'x' } }],
      meta: { sourceUrl: null, hash: 'h', frontmatterLang: null },
    }), true);
  });

  it('rejects malformed core nodes', function () {
    const base = { $md: '0.1', frontmatter: null, meta: { sourceUrl: null, hash: 'h', frontmatterLang: null } };
    assert.equal(validate({ ...base, ast: [{ type: 'heading', depth: 9, children: [] }] }), false);
    assert.equal(validate({ ...base, ast: [{ type: 'code', value: 'x' }] }), false);
    assert.equal(validate({ ...base, ast: [{ type: 'text', value: 'inline at block level?' }] }), false);
    assert.equal(validate({ $md: '9.9', frontmatter: null, ast: [], meta: base.meta }), false);
    // the new types are core types, so a malformed one is an error and
    // not an extension node that happens to be shaped differently
    assert.equal(validate({ ...base, ast: [{ type: 'footnoteDefinition', label: 'x', children: [] }] }), false);
    assert.equal(validate({
      ...base,
      ast: [{ type: 'paragraph', children: [{ type: 'footnoteReference', identifier: 'x' }] }],
    }), false);
    assert.equal(validate({ ...base, ast: [{ type: 'footnoteReference', identifier: 'x', label: 'x' }] }),
      false);
  });
});

describe('mdToForm', function () {
  it('emits a forms-consumable structure from frontmatter', function () {
    const doc = parseMarkdown([
      '---json',
      JSON.stringify({
        form: {
          type: 'object',
          properties: {
            name: { type: 'string', title: 'Name' },
            age: { type: 'integer', minimum: 0 },
          },
          required: ['name'],
        },
        data: { name: 'Ada' },
      }),
      '---',
      '# Form doc',
      '',
    ].join('\n'));
    const form = mdToForm(doc, forms);
    assert.notEqual(form, null);
    assert.equal(/** @type {any} */ (form).schema.type, 'object');
    assert.deepEqual(/** @type {any} */ (form).data, { name: 'Ada' });
    assert.equal(typeof /** @type {any} */ (form).fields, 'object');
  });

  it('returns null without a declared schema', function () {
    assert.equal(mdToForm(parseMarkdown('# no form\n'), forms), null);
    assert.equal(mdToForm(parseMarkdown('---\ntitle: x\n---\n'), forms), null);
  });
});
