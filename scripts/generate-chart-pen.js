//@ts-check
/** Derive the chart pen's closed member vocabulary and declarations from its public grammar. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileEmitModel } from '@jarenjs/emit/model';
import { renderTypeScript } from '@jarenjs/emit/typescript';

const root = resolve(import.meta.dirname, '..');
const grammar = JSON.parse(readFileSync(resolve(root, 'components/charts/schemas/chart-definition.schema.json'), 'utf8'));
const nameOf = (kind) => `${kind[0].toUpperCase()}${kind.slice(1)}Chart`;

/** Generated artifacts are compared byte-for-byte by the pen's drift gate. */
export function chartPenArtifacts() {
  const fields = {};
  const defs = { ...grammar.$defs };
  const kinds = grammar.properties.type.enum;
  for (const kind of kinds) {
    const branch = grammar.allOf.find((b) => b.if.properties.type.const === kind);
    if (!branch) throw new Error(`chart kind '${kind}' has no grammar branch`);
    const properties = { ...grammar.properties, type: { const: kind }, ...branch.then.properties };
    fields[kind] = Object.keys(properties).filter((k) => k !== 'type');
    defs[nameOf(kind)] = { type: 'object', properties, required: ['type'], additionalProperties: false };
  }
  const schema = { $defs: defs, oneOf: kinds.map((k) => ({ $ref: `#/$defs/${nameOf(k)}` })) };
  const model = compileEmitModel(schema, { name: 'ChartDefinition' });
  let declarations = '// Derived from chart-definition.schema.json by scripts/generate-chart-pen.js.\n'
    + renderTypeScript(model, { banner: false });
  declarations += '\nexport interface ChartDefinitions {\n'
    + kinds.map((k) => `  ${k}: ${nameOf(k)};`).join('\n') + '\n}\n'
    + `export type ChartKind = keyof ChartDefinitions;
type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;
export type ChartOptions<K extends ChartKind> = Omit<Immutable<ChartDefinitions[K]>, 'type'>;
export type ChartPen<K extends ChartKind> = ChartBuilder<K> & {
  readonly [P in keyof ChartOptions<K>]-?: (value: Exclude<ChartOptions<K>[P], undefined>) => ChartPen<K>;
};
/** The kind controls the available fluent members and their value types. */
export class ChartBuilder<K extends ChartKind = ChartKind> {
  protected constructor();
  readonly schema: Immutable<ChartDefinitions[K]>;
  toJSON(): Immutable<ChartDefinitions[K]>;
  options(value: ChartOptions<K>): ChartPen<K>;
}
/** A raw public chart definition; extensions remain JSON and engine-validated. */
export function from<K extends ChartKind>(document: ChartDefinitions[K]): ChartPen<K>;
`;
  declarations += kinds.map((k) => `/** A ${k} chart definition. */\nexport function ${k}(options?: ChartOptions<'${k}'>): ChartPen<'${k}'>;`).join('\n') + '\n';
  const vocabulary = '// Derived from chart-definition.schema.json by scripts/generate-chart-pen.js.\n'
    + '/** The known member set for each public chart discriminator. */\n'
    + `export const CHART_FIELDS = Object.freeze(${JSON.stringify(fields, null, 2)});\n`;
  return { declarations, vocabulary };
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const { declarations, vocabulary } = chartPenArtifacts();
  writeFileSync(resolve(root, 'packages/linq/types/charts.d.ts'), declarations);
  writeFileSync(resolve(root, 'packages/linq/src/charts/vocabulary.js'), vocabulary);
}
