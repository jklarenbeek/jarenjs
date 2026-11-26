// The JSLT compile options and the transform it returns, for a strict
// consumer: a registry's `toOptions()` is a compile's options as it comes
// (extensions and functions included), `pathFunctions` is one beside the
// rest, and the transform is a typed callable carrying `externals` and
// `doc`, from `compileJsltStylesheet` and from the registry's `compile`
// alike. A misspelt option still fails.
import { compileJsltStylesheet, transformJson, createJsltRegistry, mathPack } from '@jarenjs/json/jslt';
import type { JsltCompileOptions, JsltTransform } from '@jarenjs/json/jslt';

const sheet = [{ match: '$', body: { $sqrt: ['$.area'] } }];
const registry = createJsltRegistry().use(mathPack);

const fromOptions: JsltTransform = compileJsltStylesheet(sheet, registry.toOptions());
const once: unknown = transformJson(sheet, { area: 4 }, {}, registry.toOptions());
const withPaths = compileJsltStylesheet(sheet, { pathFunctions: {}, maxDepth: 64, memo: true });
const bound: JsltTransform = registry.compile(sheet, { maxDescentDepth: 100 });

const names: readonly string[] = fromOptions.externals;
const doc: unknown = bound.doc;
const typed: (data: unknown, externals?: Record<string, unknown>) => unknown = withPaths;
const answer: unknown = typed({ area: 9 }, { rate: 1 });

const options: JsltCompileOptions = { ...registry.toOptions(), compileTypeTest: () => () => true };
// @ts-expect-error a misspelt option is not one the compile reads
compileJsltStylesheet(sheet, { pathFunction: {} });
// @ts-expect-error nor is it on the registry's compile
registry.compile(sheet, { maxDeth: 3 });

void [once, names, doc, answer, options];
