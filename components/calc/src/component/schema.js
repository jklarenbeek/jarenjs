//@ts-check
/**
 * @file The financial-inputs JSON Schema (draft-neutral). Rendered by
 * `@jarenjs/forms` (`buildFormModel` → `buildFormViewModel`) in the
 * viewModel, and available as `schemas/financial-inputs.schema.json` for
 * `validateState`. The calculator holds no formulas — only these inputs.
 * Each title is the English of its `x-msgid` (`<x-msgid>#label` in
 * `calcMessagesEn`), which a reader's catalog translates.
 */

export const FINANCIAL_SCHEMA = {
  type: 'object',
  title: 'Time Value of Money',
  'x-msgid': 'calc/financial',
  properties: {
    nper: { type: 'number', title: 'N — number of periods', minimum: 0, 'x-msgid': 'calc/financial/nper' },
    rate: { type: 'number', title: 'I/Y — interest % per period', 'x-msgid': 'calc/financial/rate' },
    pv: { type: 'number', title: 'PV — present value', 'x-msgid': 'calc/financial/pv' },
    pmt: { type: 'number', title: 'PMT — payment', 'x-msgid': 'calc/financial/pmt' },
    fv: { type: 'number', title: 'FV — future value', 'x-msgid': 'calc/financial/fv' },
    solveFor: {
      title: 'Solve for',
      'x-msgid': 'calc/financial/solve-for',
      enum: ['pmt', 'pv', 'fv', 'nper', 'rate'],
    },
  },
  required: ['solveFor'],
};
