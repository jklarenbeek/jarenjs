//@ts-check
/** Validation shared by text commits and revision-checked publication. */
import { validateFile } from './validate.js';
import { JarenValidator } from '@jarenjs/validate';
import { jsonFormats } from '@jarenjs/formats';
import { OUR_SCHEMA_OPTIONS } from './component/shared/schema-options.js';
import dagSchema from '@jarenjs/flow/schemas/jaren-dag.schema.json' with { type: 'json' };
import querySchema from '@jarenjs/json/schemas/jaren-query.schema.json' with { type: 'json' };
import jsltSchema from '@jarenjs/json/schemas/jaren-jslt.schema.json' with { type: 'json' };
export const validateDagDoc = new JarenValidator(OUR_SCHEMA_OPTIONS)
  .addFormats(jsonFormats)
  .addSchema(querySchema)
  .addSchema(jsltSchema)
  .compile(dagSchema);


/** @param {'fsm'|'dag'} kind @param {any} document */
export function validateFlowDocument(kind, document) {
  try {
    if (kind !== 'fsm' && kind !== 'dag') throw new TypeError('The Flow kind must be fsm or dag.');
    return validateFile({ kind, text: JSON.stringify(document) });
  }
  catch (error) { return { valid: false, errors: [{ code: error.code ?? 'JF0001', message: error.message, docPath: error.docPath ?? '' }] }; }
}
