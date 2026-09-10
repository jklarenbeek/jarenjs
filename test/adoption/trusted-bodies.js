//@ts-check
/** Statically reviewed synthetic trusted bodies; no dynamic source execution. */
export const SKIP = Symbol('skip');

/** The explicitly selected compatibility host for this synthetic corpus only. */
export const trustedBodies = {
  "amount": (row, _helpers) => {
// body:amount
return row.price * row.quantity;
// end:amount
  },
  "optional": (row, _helpers) => {
// body:optional
const label = row.meta?.label;
return label ?? 'unknown';
// end:optional
  },
  "display": (row, _helpers) => {
// body:display
return new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(row.price);
// end:display
  },
  "skip": (row, helpers) => {
// body:skip
return row.provenance === 'manual' ? helpers.SKIP : row.quantity;
// end:skip
  },
  "null": (_row, _helpers) => {
// body:null
return null;
// end:null
  },
  "explain": (_row, _helpers) => {
// body:explain
return { explanation: 'protected provenance' };
// end:explain
  },
  "error": (_row, _helpers) => {
// body:error
throw new Error('synthetic failure');
// end:error
  },
};
