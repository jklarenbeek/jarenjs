// Run by reference-stack.test.js in a child process with a fixed stack: one
// validation (or normalization) deep enough that the host's call stack gives
// out under its schema references, then the answers of the validators and the
// normalizer of the same process. Prints one JSON report line.
//   node --stack-size=<kB> probe.mjs '<scenario as JSON>'
// scenario: { mode: 'first' | 'collect', exhaust?: a SHAPES name, depth?: number,
//   warm?: boolean, ceiling?: number }
import { JarenValidator } from '@jarenjs/validate';
import { compileNormalizer } from '@jarenjs/validate/normalize';
import { isStackExhausted } from '@jarenjs/core/object';

const scenario = JSON.parse(process.argv[2]);
const D19 = 'https://json-schema.org/draft/2019-09/schema';
const D20 = 'https://json-schema.org/draft/2020-12/schema';
const options = { ...(scenario.mode === 'collect' ? { collectErrors: true } : {}), ...(scenario.ceiling ? { maxReferenceDepth: scenario.ceiling } : {}) };

/** `levels` levels of `properties.x` around `leaf`, built by a loop. */
const under = (levels, leaf) => { let schema = leaf; for (let i = 0; i < levels; i++) schema = { properties: { x: schema } }; return schema; };
/** `levels` levels of `items` around `leaf`. */
const through = (levels, leaf) => { let schema = leaf; for (let i = 0; i < levels; i++) schema = { items: schema }; return schema; };
/** `{ x: { x: … } }` nested `depth` times. */
const members = (depth, leaf = {}) => { let value = leaf; for (let i = 0; i < depth; i++) value = { x: value }; return value; };
/** `[[…]]` nested `depth` times. */
const arrays = (depth) => { let value = []; for (let i = 0; i < depth; i++) value = [value]; return value; };
/** A tree `depth` nodes deep. */
const tree = (depth, leaf = {}) => { let node = leaf; for (let i = 0; i < depth; i++) node = { children: [node] }; return node; };

// Loops closed through a schema already built: each counts one or two
// references per turn of many levels, so the host's stack gives out long
// before the count does.
const SHAPES = {
  // two definitions referencing each other through 10 members each
  two: { compile: (validator) => validator.compile({ $id: 'http://depth.test/two', $ref: '#/$defs/a', $defs: { a: under(10, { $ref: '#/$defs/b' }), b: under(10, { $ref: '#/$defs/a' }) } }), instance: members },
  // the same through 3 members each
  two3: { compile: (validator) => validator.compile({ $ref: '#/$defs/a', $defs: { a: under(3, { $ref: '#/$defs/b' }), b: under(3, { $ref: '#/$defs/a' }) } }), instance: members },
  // through `items`, deeper than the schema depth bound lets one definition be built inside the other
  items: { compile: (validator) => validator.compile({ $ref: '#/$defs/a', $defs: { a: through(64, { $ref: '#/$defs/b' }), b: through(64, { $ref: '#/$defs/a' }) } }), instance: arrays },
  // a `$dynamicRef` whose initial target is another resource, 40 members a turn
  dynamic: {
    compile: (validator) => validator
      .addSchema({ $schema: D20, $id: 'urn:stack:b', $dynamicAnchor: 'node', type: 'object' })
      .compile({ $schema: D20, $id: 'urn:stack:a', $dynamicAnchor: 'node', ...under(40, { $dynamicRef: 'urn:stack:b#node' }) }),
    instance: members,
  },
  // a `$recursiveRef` in a definition built on first use, 40 members a turn
  recursive: {
    compile: (validator) => validator.compile({ $schema: D19, $id: 'urn:stack:r', $recursiveAnchor: true,
      properties: { x: { $ref: '#/$defs/inner' } }, $defs: { inner: under(40, { $recursiveRef: '#' }) } }),
    instance: members,
  },
  // the normalizer, which holds the same count
  normalizer: {
    compile: () => compileNormalizer({ $ref: '#/$defs/a', $defs: { a: under(10, { $ref: '#/$defs/b' }), b: under(10, { $ref: '#/$defs/a' }) } },
      scenario.ceiling ? { maxReferenceDepth: scenario.ceiling } : {}),
    instance: members,
  },
};

/** What a call answers: its verdict, or the class, code and kind of what it threw. */
const answer = (run) => {
  try {
    const result = run();
    return typeof result === 'boolean' ? result : typeof result?.valid === 'boolean' ? result.valid : 'value';
  }
  catch (error) {
    return `${error?.name}:${error?.code ?? 'uncoded'}`;
  }
};

/** The refusal of the deep call, in full. */
const refusal = (run) => {
  try {
    const result = run();
    return { answered: typeof result === 'boolean' ? result : typeof result?.valid === 'boolean' ? result.valid : 'value' };
  }
  catch (error) {
    return { name: error?.name, code: error?.code ?? null, message: String(error?.message),
      byStack: /call stack/.test(String(error?.message)), cause: error?.cause === undefined ? null : isStackExhausted(error.cause) ? 'the host\'s stack refusal' : 'another error' };
  }
};

// the validators and the normalizer whose answers must not move
const self = new JarenValidator(options).compile({ properties: { x: { $ref: '#' } } });
const unevaluated = new JarenValidator(options).compile({ $schema: D20, properties: { x: { $ref: '#' } }, unevaluatedProperties: false });
const strictOrLoose = new JarenValidator(options)
  .addSchema({ $schema: D20, $id: 'urn:stack:tree', $dynamicAnchor: 'node', type: 'object', properties: { data: true, children: { type: 'array', items: { $dynamicRef: '#node' } } } })
  .addSchema({ $schema: D20, $id: 'urn:stack:strict', $dynamicAnchor: 'node', $ref: 'urn:stack:tree', unevaluatedProperties: false })
  .compile({ $schema: D20, properties: { s: { $ref: 'urn:stack:strict' }, l: { $ref: 'urn:stack:tree' } } });
const branches = new JarenValidator(options).compile({ anyOf: [{ $ref: '#/$defs/n' }, { type: 'string' }], $defs: { n: { type: 'object', properties: { x: { $ref: '#' } }, required: ['x'] } } });
const normalize = compileNormalizer({ type: 'object', properties: { x: { $ref: '#' }, n: { type: 'integer', default: 1 } } }, { useDefaults: true });

const report = { stackSize: process.execArgv.join(' '), scenario };
if (scenario.exhaust !== undefined) {
  const shape = SHAPES[scenario.exhaust];
  const run = shape.compile(new JarenValidator(options));
  // warmed: the deep call runs code the host has optimized
  if (scenario.warm) { const shallow = shape.instance(100); for (let i = 0; i < 20000; i++) run(shallow); }
  if (scenario.strictTree) report.tree = refusal(() => strictOrLoose({ s: tree(scenario.strictTree) }));
  report.deep = (scenario.depths ?? [scenario.depth ?? 100000]).map((depth) => refusal(() => run(shape.instance(depth))));
}
const CEILING = [254, 255, 256, 257, 258, 259, 260, 261];
report.after = {
  // a shallow instance, right and wrong
  shallow: [answer(() => self(members(3))), answer(() => self(members(3, 1))), answer(() => unevaluated(members(3))), answer(() => unevaluated(members(2, { y: 1 }))),
    answer(() => branches(members(3, 'leaf'))), answer(() => branches(members(3, 1)))],
  // exactly at the reference depth bound and one level past it
  self: [answer(() => self(members(256))), answer(() => self(members(257)))],
  unevaluated: CEILING.map((depth) => answer(() => unevaluated(members(depth)))),
  branches: CEILING.map((depth) => answer(() => branches(members(depth, 'leaf')))),
  // the dynamic scope: the loose tree takes a member the strict one refuses
  dynamic: [answer(() => strictOrLoose({ l: tree(3, { extra: 1 }) })), answer(() => strictOrLoose({ s: tree(3, { extra: 1 }) })), answer(() => strictOrLoose({ s: tree(3) }))],
  // the normalizer shares the count
  normalizer: [JSON.stringify(normalize(members(2))), ...CEILING.map((depth) => answer(() => normalize(members(depth))))],
  // an array element holding `undefined` is still read as one
  undefinedElement: [answer(() => new JarenValidator(options).compile({ items: { type: 'null' } })([undefined])), answer(() => new JarenValidator(options).compile({ type: 'null' })(undefined))],
};
process.stdout.write(`${JSON.stringify(report)}\n`);
