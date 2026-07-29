//@ts-check
/**
 * @file The cyclic verification: the generator and the validator must agree.
 *
 * A code generator that is merely *plausible* is worthless — it will
 * confidently emit a type that says one thing while the validator enforces
 * another, and the mismatch surfaces in production as data that passed
 * validation and violates its own declared type.
 *
 * This closes the loop. One schema goes two ways:
 *
 *        ┌────────────────────────────────────────────┐
 *        │                 JSON Schema                │
 *        └──────────────┬──────────────┬──────────────┘
 *                       │              │
 *          @jarenjs/emit│              │@jarenjs/validate
 *                       ▼              ▼
 *              TypeScript type    compiled validator
 *                       │              │
 *                       └──────┬───────┘
 *                              ▼
 *                   the SAME instances, and the
 *                   two answers must correspond
 *
 * Owning both sides is what makes this testable, and it is the thing a
 * standalone schema-to-TypeScript tool structurally cannot do: it has no
 * validator to disagree with.
 *
 * **The check is split across two gates on purpose.**
 *
 *  - *This* file owns the validator side and the fixture's freshness: the
 *    corpus verdicts, and that `test/consumer/emit-generated.ts` is exactly
 *    what the generator produces today.
 *  - The *type* side lives in `test/consumer/types.ts` under
 *    `npm run test:types`, because TypeScript has to be the judge of a
 *    TypeScript question. Spawning a compiler from inside the test runner was
 *    tried first and is not reliable enough to gate a push on.
 *
 * Together they are the loop: this file proves the fixture is what the
 * generator produces, and the type gate proves that fixture corresponds to
 * the validator's verdicts.
 *
 * The correspondence is deliberately NOT "the two always agree", because that
 * would be false. TypeScript cannot express `minLength` or `pattern`, so a
 * value can be type-correct and schema-invalid. The corpus states which
 * relationship each instance is in, and both gates assert all three —
 * including the widening, which is what keeps the generator honest instead of
 * letting it quietly claim more than it delivers.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';

import { compileEmitModel } from '@jarenjs/emit/model';
import { emitTypeScript } from '@jarenjs/emit/typescript';
import { JarenValidator } from '@jarenjs/validate';

import { CORPUS } from './corpus.js';

const FIXTURE = new URL('../consumer/emit-generated.ts', import.meta.url);

/** The compiled validators, one per corpus entry. */
const validators = CORPUS.map((entry) => new JarenValidator().compile(entry.schema));

describe('emit — the validator side of the loop', () => {
  it('accepts every instance the corpus calls valid', () => {
    CORPUS.forEach((entry, i) => {
      for (const instance of entry.valid) {
        assert.strictEqual(validators[i](instance), true,
          `${entry.name}: expected valid — ${JSON.stringify(instance)}`);
      }
    });
  });

  it('rejects every structurally invalid instance', () => {
    CORPUS.forEach((entry, i) => {
      for (const instance of entry.invalidShape) {
        assert.strictEqual(validators[i](instance), false,
          `${entry.name}: expected invalid — ${JSON.stringify(instance)}`);
      }
    });
  });

  it('rejects the widened instances too — the type accepts what the schema does not', () => {
    // The row that makes the widening honest rather than hidden: the validator
    // says no, the generated type says yes, and the generated file carries a
    // comment saying exactly which constraint it could not express.
    CORPUS.forEach((entry, i) => {
      for (const instance of entry.invalidWidened) {
        assert.strictEqual(validators[i](instance), false,
          `${entry.name}: expected invalid — ${JSON.stringify(instance)}`);
      }
    });
  });
});

describe('emit — the generated fixture is current', () => {
  it('matches exactly what the generator produces today', () => {
    // The type gate checks a COMMITTED file. If the generator could drift from
    // it, that gate would be checking history rather than the generator, and
    // the loop would be open. This is what keeps it closed.
    const committed = fs.readFileSync(FIXTURE, 'utf8');
    const header = committed.slice(0, committed.indexOf('\n\n') + 2);
    let fresh = header;
    for (const entry of CORPUS) {
      fresh += emitTypeScript(entry.schema, {
        name: entry.name, banner: false, normalize: entry.normalize ?? null,
      });
    }
    assert.strictEqual(committed, fresh,
      'test/consumer/emit-generated.ts is stale — regenerate it with '
      + '`node scripts/generate-emit-fixture.js`');
  });

  it('documents, in the generated file, every constraint the type cannot carry', () => {
    const committed = fs.readFileSync(FIXTURE, 'utf8');
    assert.match(committed, /Schema constraints this type cannot express: minLength=3/);
  });
});

describe('emit — the variant pair closes the same loop', () => {
  it('normalizes a raw input into something the normalized side describes', async () => {
    // The type gate proves a raw input satisfies ConfigInput and not Config.
    // This proves the other half at runtime: the normalizer really does turn
    // one into the other, so the pair describes a transition that happens
    // rather than one the generator merely asserts.
    const { compileNormalizer } = await import('@jarenjs/validate/normalize');
    for (const entry of CORPUS) {
      if (entry.normalize === undefined || entry.rawInput === undefined) continue;
      const normalize = compileNormalizer(entry.schema, entry.normalize);
      const validate = new JarenValidator().compile(entry.schema);
      const model = compileEmitModel(entry.schema,
        { name: entry.name, normalize: entry.normalize });
      const normalized = model.declarations.find((d) => d.variant === 'normalized');

      for (const raw of entry.rawInput) {
        const shaped = normalize(raw);
        assert.strictEqual(validate(shaped), true,
          `${entry.name}: normalizing ${JSON.stringify(raw)} must produce a valid document`);
        // Everything the normalized declaration calls required must be there.
        for (const member of normalized.type.members) {
          if (!member.required) continue;
          assert.ok(Object.hasOwn(shaped, member.name),
            `${entry.name}.${member.name} is required on the normalized side, `
            + `but normalizing ${JSON.stringify(raw)} did not produce it`);
        }
      }
    }
  });
});

describe('emit — determinism', () => {
  it('produces byte-identical output for the same input', () => {
    for (const entry of CORPUS) {
      const opts = { name: entry.name, normalize: entry.normalize ?? null };
      const once = emitTypeScript(entry.schema, opts);
      const twice = emitTypeScript(entry.schema, opts);
      assert.strictEqual(once, twice, `${entry.name} is not byte-stable`);
      assert.strictEqual(
        JSON.stringify(compileEmitModel(entry.schema, opts)),
        JSON.stringify(compileEmitModel(entry.schema, opts)),
        `${entry.name} model is not byte-stable`);
    }
  });
});
