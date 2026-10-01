import { roundExact, exactDecimal, roundDecimal, type Decimal } from '@jarenjs/core/math';
import { UNIT_ALIASES, unitOfAlias } from '@jarenjs/core/convert';
import { compileJsonQuery } from '@jarenjs/json';
import { createJsltRegistry, mathPack, type JsltRegistry, type JsltPack } from '@jarenjs/json/jslt';
import { compileFormula } from '@jarenjs/json/formula';
import { defineFormula } from '@jarenjs/linq/formula';
import { compileDateLocale, compileNumberLocale, numberMessagesEn, nl } from '@jarenjs/locales';
import { compileNumberLocale as compileFromSubpath, type DecimalFormat } from '@jarenjs/locales/numbers';

const rounded: number = roundExact(1.005, 2, 'half-even');
const exact: Decimal = exactDecimal(2.5);
const digits: string = roundDecimal(exact, 0, 'half-up').digits;
const unit: string | undefined = unitOfAlias('gram');
const kilo: string = UNIT_ALIASES.kilo;
const format: Readonly<DecimalFormat> = compileNumberLocale(nl).decimalFormat;
const separator: string = compileFromSubpath().decimalFormat.decimalSeparator;
const english: Record<string, string> = numberMessagesEn;
const price = compileJsonQuery({ '$format-number': ['$.p', '#.##0,00', 'nl'] },
  { decimalFormats: { nl: format }, dateNames: compileDateLocale(nl).names });
const mine: JsltPack = { name: 'mine', version: '1', entries: {} };
const registry: Readonly<JsltRegistry> = createJsltRegistry().use(mathPack).use(mine);
const listed: { name: string, version: string | null }[] = registry.packs();
const picked = registry.forPacks(['math']).extensions;
const side = compileFormula(defineFormula('side', { $sqrt: ['$.area'] }, { packs: [{ name: 'math', version: '1' }] }),
  { packs: registry, decimalFormats: { nl: format } });
side.evaluate({ area: 4 });
void [rounded, digits, unit, kilo, separator, english, price, listed, picked];
// @ts-expect-error a rounding mode is half-up or half-even
roundExact(1, 2, 'half-down');
// @ts-expect-error a tie rule is required
roundDecimal(exact, 2);
