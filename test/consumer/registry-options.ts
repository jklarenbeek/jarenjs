// The JSLT registry's raw `{ extensions, functions }` spread into a manual
// compile call: the members carry the `$call` registry type the query
// compiler takes, so a strict consumer needs no cast.
import { compileJsonQuery, type CompiledJsonQuery } from '@jarenjs/json/query';
import { createJsltRegistry, mathPack, statsPack } from '@jarenjs/json/jslt';

const registry = createJsltRegistry().use(mathPack).use(statsPack);
const spread: CompiledJsonQuery = compileJsonQuery({ $sqrt: ['$.area'] }, { ...registry.toOptions() });
const picked: CompiledJsonQuery = compileJsonQuery({ $sqrt: ['$.area'] }, registry.forPacks(['math']));
const sides: number = spread({ area: 4 }) + picked({ area: 9 });
// a variable typed with the earlier, looser declaration still takes both members
const loose: Record<string, Function> = registry.toOptions().functions;
const loosePicked: Record<string, Function> = registry.forPacks(['math']).functions;
void [sides, loose, loosePicked];
