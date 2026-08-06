//@ts-check
/**
 * @file The `./component` factory. The IDE chrome lands in the next
 * order; today the factory exposes the engine surface a host binds at
 * mount time (parse, describe, validate, classify) and threads a host
 * operator registry into the per-file validators.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createStudioComponent } from '@jarenjs/studio/component';
import { createJsltRegistry } from '@jarenjs/json/jslt';

const projectDoc = {
  project: '0.1',
  files: [{ name: 'q', kind: 'query', text: '{"$for":{"it":"$[*]"},"$return":"$it"}' }],
};

describe('createStudioComponent', () => {
  it('exposes the engine surface (parse / describe / validate / classify)', () => {
    const c = createStudioComponent();
    const p = c.parseProject(projectDoc);
    assert.strictEqual(c.describe(p).files[0].kind, 'query');
    assert.strictEqual(c.validateFile(p.files[0]).valid, true);
    assert.strictEqual(typeof c.classifyChange, 'function');
  });

  it('threads a host operator registry to the per-file validators', () => {
    const c = createStudioComponent({ operators: createJsltRegistry() }); // no packs
    const r = c.validateFile({ name: 'v', kind: 'query', text: '{"v":{"$npv":["$.r","$.cf[*]"]}}' });
    assert.strictEqual(r.valid, false, 'without the finance pack, $npv is unknown');
  });
});
