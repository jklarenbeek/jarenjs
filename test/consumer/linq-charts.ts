import { bar, line, pie, gauge, map, from, ChartBuilder } from '@jarenjs/linq/charts';
const bars = bar().categories(['A']).series([{ name: 'N', values: [1] }]).stacked(true);
const kind: 'bar' = bars.schema.type;
const lines = line().x('time').series([{ name: 'N', points: [{ x: 1, y: 2 }] }]).sampling({ method: 'lttb', target: 100 });
void [kind, lines, gauge().value(2).tone('win'), map().value('pop'), from({ type: 'pie' }), ChartBuilder];
// @ts-expect-error a bar has no pie slices
bars.slices([]);
// @ts-expect-error a pie's value must be numeric
pie().slices([{ label: 'A', value: 'x' }]);
// @ts-expect-error map value is a property name
map().value(1);
// @ts-expect-error unsupported known-option members use the raw boundary
bar({ extension: true });
// @ts-expect-error literal discriminator survives options and title
const wrong: 'pie' = bars.options({ title: 'T' }).schema.type;
void wrong;
