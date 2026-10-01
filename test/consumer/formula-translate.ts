import { compileFormula, checkFormulaParity } from '@jarenjs/json/formula';
import { migrateFormulas, translateFormulaBody } from '@jarenjs/json/formula/migrate';

const t = translateFormulaBody('return item.a ?? 0;', {
  argument: 'item', helperObject: 'helpers', skip: 'SKIP', explain: 'because', explanationMember: null,
  helpers: { twice: { native: { params: ['v'], expression: { $mul: ['$v', 2] } }, returns: 'number' }, slug: { call: { name: 'slug', version: '1' } } },
  locales: { 'nl-NL': { decimalFormat: 'nl', grouping: '.', decimal: ',', currencies: { EUR: '€ #.##0,00;€ -#.##0,00' } } },
});
const state: 'translated' | 'translated-with-differences' | 'untranslatable' = t.state;
const line: number = (t.differences[0] ?? t.reasons[0])?.at.line ?? 1;
const formula = compileFormula({ $formula: '1', id: 'f', revision: '1', expression: t.expression });
const parity = checkFormulaParity(formula, [{ a: 1 }], [{ kind: 'value', value: 1 }], { maxMismatches: 5 });
const agree: number = parity.agree;
const mismatch: number | undefined = parity.mismatches[0]?.index;
void [state, line, agree, mismatch, migrateFormulas([], [], { translate: { argument: 'item' } })];
// @ts-expect-error an unknown option is refused
translateFormulaBody('return 1;', { argumnet: 'x' });
