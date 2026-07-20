//@ts-check
/**
 * @file The financial-inputs JSON Schema (draft-neutral). Rendered by
 * `@jarenjs/forms` (`buildFormModel` → `buildFormViewModel`) in the
 * viewModel, and available as `schemas/financial-inputs.schema.json` for
 * `validateState`. The calculator holds no formulas — only these inputs.
 */

export const FINANCIAL_SCHEMA = {
  type: 'object',
  title: 'Time Value of Money',
  properties: {
    nper: { type: 'number', title: 'N — number of periods', minimum: 0 },
    rate: { type: 'number', title: 'I/Y — interest % per period' },
    pv: { type: 'number', title: 'PV — present value' },
    pmt: { type: 'number', title: 'PMT — payment' },
    fv: { type: 'number', title: 'FV — future value' },
    solveFor: {
      title: 'Solve for',
      enum: ['pmt', 'pv', 'fv', 'nper', 'rate'],
    },
  },
  required: ['solveFor'],
};
