//@ts-check
/** Every existing JTLT fixture crosses both public grammars as it reaches its engine. */
import * as assert from 'node:assert/strict';
import { JarenValidator } from '@jarenjs/validate';
import * as engine from '@jarenjs/json/jtlt';
import latest from '@jarenjs/json/schemas/jaren-jtlt.schema.json' with { type: 'json' };
import old from '@jarenjs/json/schemas/jaren-jtlt.draft-07.schema.json' with { type: 'json' };
export { JtltCompileError, JtltRuntimeError } from '@jarenjs/json/jtlt';

// Format annotations stay annotations here: custom path functions and schema
// hooks are host bindings that only the compiler's actual options can resolve.
const validators = [latest, old].map((schema) => new JarenValidator().compile(schema));

function check(doc, error) {
  const verdicts = validators.map((validate) => validate(doc));
  assert.equal(verdicts[0], verdicts[1], 'JTLT draft parity');
  if (error instanceof engine.JtltCompileError) {
    // TL0005 is the inherited query/compiler boundary: hook availability,
    // path syntax, operator arguments and literal apply modes need compilation.
    if (error.code !== 'TL0005') assert.equal(verdicts[0], false, `${error.code}: ${JSON.stringify(doc)}`);
  }
  else assert.equal(verdicts[0], true, JSON.stringify(doc));
}

/** Compile through the engine and hold its existing fixtures to both grammars. */
export function compileJtltStylesheet(doc, options) {
  let result;
  try { result = engine.compileJtltStylesheet(doc, options); }
  catch (error) { check(doc, error); throw error; }
  check(doc);
  return result;
}

/** Keep the cache tests on the real one-call API; schema checks never compile a renderer. */
export function renderText(doc, data, externals, options) {
  let result;
  try { result = engine.renderText(doc, data, externals, options); }
  catch (error) { check(doc, error); throw error; }
  check(doc);
  return result;
}
