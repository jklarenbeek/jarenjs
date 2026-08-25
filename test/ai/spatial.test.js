//@ts-check
/**
 * @file The spatial authoring profile: the stylesheet author with the
 * §8.14 rules taught in the prompt and refused at the gate.
 *
 * NO MODEL WAS RUN for these assertions. Every document below is a
 * recorded fixture — the shapes a cheap model produces when it reaches
 * for what the internet taught it — and the claims are about the gates
 * and the prompt, not about a model's behaviour. Where a key is
 * available the author can be driven live with the same options; the
 * session record states which of the two happened.
 *
 * What is asserted that reading the code cannot settle:
 *
 *  - **The profile teaches exactly §8.14.** The crib's operator table is
 *    held to `QUERY-FORMAT.md`'s own §8.14 table, so a format change
 *    fails here before the prompt can teach a vocabulary that does not
 *    exist.
 *  - **The prefix refusal is the profile's most valuable one (D7).** A
 *    document that compiles, runs and answers something is refused when
 *    the question asked for nearness, naming `$geohash-neighbours`, and
 *    passed when it asked for bucketing.
 *  - **Arithmetic over a coordinate member is refused (D5)** with a
 *    pointer at the operator, even though it is legal arithmetic over
 *    numbers to the schema and the engine.
 *  - **"Compiles" is not "runs".** The run gate is exercised on the real
 *    places dataset and the correct document is proven to RUN and to
 *    answer the question, not only to compile.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';

import {
  createSpatialAuthor, createStructuredOutput, spatialGates, prefixProximityGate,
  planarArithmeticGate, spatialOperatorGate, spatialCrib, spatialIntent, spatialSystemMessage,
  describeSpatialPaths, coordinateMembers, operatorCrib, runGate, compileGate,
  unknownOperatorGate, SPATIAL_OPERATORS, SPATIAL_EXAMPLE, STYLESHEET_EXAMPLE, stylesheetSystemMessage,
} from '@jarenjs/ai';
import { JarenValidator } from '@jarenjs/validate';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { parseCsv } from '@jarenjs/josl';
import authoringSchema from '@jarenjs/json/schemas/jaren-jslt.authoring.schema.json' with { type: 'json' };
import canonicalSchema from '@jarenjs/json/schemas/jaren-jslt.schema.json' with { type: 'json' };
import querySchema from '@jarenjs/json/schemas/jaren-query.schema.json' with { type: 'json' };
import { sectionOf } from '../format-sections.js';

/** The real dataset: the CSV the round-trip recipe reads, as the
 * sample the profile grounds on and the run gate runs on. */
const PLACES = parseCsv(readFileSync(new URL('../json/fixtures/places.csv', import.meta.url), 'utf8'),
  { headers: true, typed: true }).map((row) => ({ name: row.name, at: [row.lon, row.lat] }));

const REGION = {
  type: 'Polygon',
  coordinates: [[[3.3, 50.7], [7.3, 50.7], [7.3, 53.6], [3.3, 53.6], [3.3, 50.7]]],
};

const SAMPLE = { centre: [4.9041, 52.3676], region: REGION, places: PLACES };

// —— recorded fixtures: what a model writes when it gets a rule wrong ——

/** Rule 3 wrong: the geohash-prefix folklore, compiles and runs. */
const PREFIX_FOLKLORE = {
  $jslt: '0.1',
  rules: [{
    match: '$',
    body: {
      $for: { c: '$.places[*]' },
      $where: { '$starts-with': [{ $geohash: ['$c.at', 6] }, { $geohash: ['$.centre', 4] }] },
      $return: '$c.name',
    },
  }],
};

/** The same folklore spelled as "same cell". */
const SAME_CELL = {
  $jslt: '0.1',
  rules: [{
    match: '$',
    body: {
      $for: { c: '$.places[*]' },
      $where: { $eq: [{ $geohash: ['$c.at', 5] }, { $geohash: ['$.centre', 5] }] },
      $return: '$c.name',
    },
  }],
};

/** Rule 1 wrong: Pythagoras over degrees, compiles and runs. */
const PLANAR = {
  $jslt: '0.1',
  rules: [{
    match: '$',
    body: {
      $head: {
        $for: { c: '$.places[*]' },
        $orderby: {
          $add: [
            { $mul: [{ $sub: ['$c.at[0]', '$.centre[0]'] }, { $sub: ['$c.at[0]', '$.centre[0]'] }] },
            { $mul: [{ $sub: ['$c.at[1]', '$.centre[1]'] }, { $sub: ['$c.at[1]', '$.centre[1]'] }] },
          ],
        },
        $return: '$c.name',
      },
    },
  }],
};

/** A "within" spelled as a box of comparisons: no spatial operator. */
const LATLON_BOX = {
  $jslt: '0.1',
  rules: [{
    match: '$',
    body: {
      $for: { c: '$.places[*]' },
      $where: { $and: [{ $gt: ['$c.at[1]', 50.7] }, { $lt: ['$c.at[1]', 53.6] }, { $gt: ['$c.at[0]', 3.3] }, { $lt: ['$c.at[0]', 7.3] }] },
      $return: '$c.name',
    },
  }],
};

/** The correct document: the nine-cell probe, then the exact distance. */
const NINE_CELLS = {
  $jslt: '0.1',
  rules: [{
    match: '$',
    body: {
      $let: { cells: { '$geohash-neighbours': { $geohash: ['$.centre', 3] } } },
      $return: {
        $for: { c: '$.places[*]' },
        $where: { $exists: { '$index-of': ['$cells', { $geohash: ['$c.at', 3] }] } },
        $orderby: [{ $key: { $distance: ['$c.at', '$.centre'] } }],
        $return: '$c.name',
      },
    },
  }],
};

/** A client that answers with whatever documents it was handed, in
 * order (the stylesheet test's replaying client). */
function replaying(...replies) {
  const sent = [];
  return {
    sent,
    endpoint: { provider: 'openrouter', model: 'stub' },
    complete: async (request) => {
      sent.push(request);
      const reply = replies[Math.min(sent.length - 1, replies.length - 1)];
      return {
        message: { role: 'assistant', content: JSON.stringify(reply) },
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
  };
}

const run = (doc) => compileJsltStylesheet(doc)(SAMPLE);

describe('ai — the spatial profile teaches exactly §8.14', function () {
  it('names the operators QUERY-FORMAT §8.14 publishes, and no other', function () {
    const format = readFileSync(new URL('../../packages/json/docs/QUERY-FORMAT.md', import.meta.url), 'utf8');
    const published = [...sectionOf(format, '### 8.14').matchAll(/^\| `(\$[a-z-]+)` \|/gm)].map((m) => m[1]);
    assert.ok(published.length >= 13, `the section publishes a table (${published.length} rows)`);
    assert.deepStrictEqual(Object.keys(SPATIAL_OPERATORS), published,
      'the profile teaches the format\'s own table, in its order');
    // and every one is in the grammar the author reads its crib from
    const known = unknownOperatorGate({ grammar: querySchema });
    for (const name of published) {
      assert.strictEqual(known([{ match: '$', body: { [name]: '$' } }]), true, `${name} is in the grammar`);
    }
  });

  it('states the three rules in the crib, in the words a model acts on', function () {
    const crib = spatialCrib();
    assert.match(crib, /GEODESIC, NEVER PLANAR/);
    assert.match(crib, /68 km at 52°N/, 'the Dutch-latitude two-thirds error, as a number');
    assert.match(crib, /REPRESENTATIVE POSITION/);
    assert.match(crib, /centroid/);
    assert.match(crib, /BUCKETING, NOT PROXIMITY/);
    assert.match(crib, /\$geohash-neighbours/);
    assert.ok(!/\$project|buffer|union/.test(crib), 'nothing outside §8.14 is offered');
  });

  it('is the stylesheet author\'s message with the crib and a spatial example, not a fork', function () {
    const crib = operatorCrib(querySchema);
    const spatial = spatialSystemMessage(crib);
    const general = stylesheetSystemMessage(crib);
    assert.ok(spatial.startsWith(general.slice(0, 200)), 'the same opening: what a stylesheet is');
    assert.ok(spatial.includes(spatialCrib()), 'the spatial rules');
    assert.ok(spatial.includes(JSON.stringify(SPATIAL_EXAMPLE)), 'the spatial example');
    assert.ok(!spatial.includes(JSON.stringify(STYLESHEET_EXAMPLE)), 'and not the general one');
    assert.ok(spatial.endsWith('Reply with the stylesheet document only.'));
    assert.ok(spatial.length < 6000, `small enough for a prompt (${spatial.length} chars)`);
  });

  it('the worked example compiles AND runs, answering the three Dutch cities nearest first', function () {
    assert.doesNotThrow(() => compileJsltStylesheet(SPATIAL_EXAMPLE));
    assert.deepStrictEqual(run(SPATIAL_EXAMPLE), [
      { name: 'Amsterdam', km: 0 }, { name: 'Utrecht', km: 34 }, { name: 'Rotterdam', km: 57 },
    ]);
    assert.strictEqual(unknownOperatorGate({ grammar: querySchema })(SPATIAL_EXAMPLE), true);
    const canonical = new JarenValidator({ skipErrors: false, collectErrors: true }).compile(canonicalSchema);
    assert.strictEqual(canonical(SPATIAL_EXAMPLE).valid, true, 'and it is in the canonical grammar');
  });

  it('grounds the question in which paths hold a position', function () {
    const digest = describeSpatialPaths(SAMPLE);
    assert.match(digest, /\$\.places\[\*\]\.at {2}array/, 'the ordinary digest');
    assert.match(digest, /POSITION[^\n]*\$\.centre, \$\.places\[\*\]\.at$/, 'the positions, named');
    const note = digest.slice(digest.indexOf('POSITION'));
    assert.ok(!note.includes('$.region.coordinates'), 'a geometry\'s own vertices are not offered for indexing');
    assert.deepStrictEqual([...coordinateMembers(SAMPLE)].slice(-2), ['centre', 'at']);
    assert.strictEqual(describeSpatialPaths({ a: 1 }).includes('POSITION'), false, 'nothing to say when nothing is one');
  });

  it('reads the ask off the question', function () {
    assert.deepStrictEqual(spatialIntent('places near here'), { proximity: true, spatial: true });
    assert.deepStrictEqual(spatialIntent('the cities within 50 km of Amsterdam'), { proximity: true, spatial: true });
    assert.deepStrictEqual(spatialIntent('group the places by geohash cell'), { proximity: false, spatial: true });
    assert.deepStrictEqual(spatialIntent('the cities inside the region'), { proximity: false, spatial: true });
    assert.deepStrictEqual(spatialIntent('the highest-scoring item'), { proximity: false, spatial: false });
  });
});

describe('ai — the prefix refusal (D7): bucketing offered as proximity', function () {
  it('is the profile\'s most valuable refusal: the document compiles, runs, and is wrong', function () {
    // every existing authority accepts it
    assert.strictEqual(compileGate({ compile: compileJsltStylesheet })(PREFIX_FOLKLORE), true);
    assert.strictEqual(runGate({ compile: compileJsltStylesheet, sample: SAMPLE })(PREFIX_FOLKLORE), true);
    assert.strictEqual(run(PREFIX_FOLKLORE), 'Amsterdam',
      'and it answers something plausible: Utrecht, 34 km away, is in another cell');

    const outcome = prefixProximityGate({ proximity: true })(PREFIX_FOLKLORE);
    assert.notStrictEqual(outcome, true);
    assert.strictEqual(outcome.errors[0].code, 'AI0230');
    assert.strictEqual(outcome.errors[0].docPath, '/rules/0/body/$where/$starts-with');
    assert.match(outcome.errors[0].message, /\$geohash-neighbours/, 'the fix is named');
    assert.match(outcome.errors[0].message, /bucketing, not proximity/);
  });

  it('refuses "same cell" spelled with $eq, the same folklore', function () {
    const outcome = prefixProximityGate({ proximity: true })(SAME_CELL);
    assert.strictEqual(outcome.errors[0].code, 'AI0230');
    assert.strictEqual(outcome.errors[0].docPath, '/rules/0/body/$where/$eq');
  });

  it('passes the same document when the question asked for bucketing', function () {
    assert.strictEqual(prefixProximityGate({ proximity: false })(PREFIX_FOLKLORE), true,
      'a prefix is exactly right for "group by cell"');
    const gates = spatialGates({ question: 'group the places by geohash cell', sample: SAMPLE });
    assert.ok(gates.every((gate) => gate(PREFIX_FOLKLORE) === true));
  });

  it('passes the nine-cell probe, which runs and answers correctly', function () {
    assert.strictEqual(prefixProximityGate({ proximity: true })(NINE_CELLS), true);
    for (const gate of spatialGates({ question: 'places near the centre', sample: SAMPLE }))
      assert.strictEqual(gate(NINE_CELLS), true);
    assert.deepStrictEqual(run(NINE_CELLS), ['Amsterdam', 'Utrecht', 'Rotterdam'],
      'the cells narrow, the distance orders');
  });
});

describe('ai — the planar refusal (D5): arithmetic over a coordinate member', function () {
  it('refuses Pythagoras over degrees with a pointer at the operator', function () {
    assert.strictEqual(compileGate({ compile: compileJsltStylesheet })(PLANAR), true, 'legal arithmetic');
    assert.strictEqual(runGate({ compile: compileJsltStylesheet, sample: SAMPLE })(PLANAR), true, 'over numbers');
    const outcome = planarArithmeticGate({ members: coordinateMembers(SAMPLE) })(PLANAR);
    assert.notStrictEqual(outcome, true);
    assert.strictEqual(outcome.errors[0].code, 'AI0231');
    assert.strictEqual(outcome.errors[0].docPath, '/rules/0/body/$head/$orderby/$add');
    assert.match(outcome.errors[0].message, /\$c\.at\[0\]/, 'the coordinate operand is named');
    assert.match(outcome.errors[0].message, /\$distance/, 'and the geodesic fix');
    assert.match(outcome.errors[0].message, /two thirds/);
  });

  it('knows a coordinate by the sample, and by the names the world uses', function () {
    const counts = { $jslt: '0.1', rules: [{ match: '$', body: { $sub: ['$.counts[0]', 1] } }] };
    assert.strictEqual(planarArithmeticGate({ members: coordinateMembers({ counts: [3] }) })(counts), true,
      'one number is not a position; indexing it is ordinary arithmetic');
    // the kernel's rule is "two or more numbers", so a two-number array
    // IS a position to it and to this gate — the sample decides
    assert.strictEqual(planarArithmeticGate({ members: coordinateMembers({ counts: [3, 4] }) })(counts).errors[0].code,
      'AI0231');
    const named = { $jslt: '0.1', rules: [{ match: '$', body: { $sub: ['$.a.lat', '$.b.latitude'] } }] };
    assert.strictEqual(planarArithmeticGate()(named).errors[0].code, 'AI0231', 'lat/latitude need no sample');
    const geometry = { $jslt: '0.1', rules: [{ match: '$', body: { $mul: ['$.g.coordinates[1]', 2] } }] };
    assert.strictEqual(planarArithmeticGate()(geometry).errors[0].code, 'AI0231', 'nor does coordinates[i]');
  });

  it('passes geodesic arithmetic — kilometres from metres', function () {
    assert.strictEqual(planarArithmeticGate({ members: coordinateMembers(SAMPLE) })(SPATIAL_EXAMPLE), true);
  });
});

describe('ai — a spatial ask answered with no spatial operator', function () {
  it('refuses the lat/lon box that "means" within', function () {
    assert.deepStrictEqual(run(LATLON_BOX), ['Amsterdam', 'Utrecht', 'Rotterdam'],
      'it even answers right for a rectangle — and would not for any other region');
    const outcome = spatialOperatorGate({ spatial: true })(LATLON_BOX);
    assert.strictEqual(outcome.errors[0].code, 'AI0232');
    assert.match(outcome.errors[0].message, /\$within/);
    assert.strictEqual(spatialOperatorGate({ spatial: false })(LATLON_BOX), true, 'not every question is spatial');
    assert.strictEqual(spatialOperatorGate({ spatial: true })(SPATIAL_EXAMPLE), true);
  });
});

describe('ai — the spatial author (recorded fixtures, no model run)', function () {
  const base = {
    createStructuredOutput,
    compile: compileJsltStylesheet,
    schema: authoringSchema,
    canonical: canonicalSchema,
    grammar: querySchema,
  };

  it('sends the spatial crib, the example and the position note, on the narrowed schema', async function () {
    const client = replaying(SPATIAL_EXAMPLE);
    const result = await createSpatialAuthor({ ...base, client })
      .author('the cities inside the region, nearest to the centre first', { sample: SAMPLE });
    assert.deepStrictEqual(result.value, SPATIAL_EXAMPLE);
    const [request] = client.sent;
    const system = String(request.messages[0].content);
    const user = String(request.messages[1].content);
    assert.match(system, /BUCKETING, NOT PROXIMITY/);
    assert.match(system, /"\$within"/, 'the spatial example');
    assert.match(user, /POSITION[^\n]*\$\.places\[\*\]\.at/, 'the grounding names the positions');
    assert.strictEqual(request.responseFormat.schema.$id, authoringSchema.$id, 'the authoring profile');
    assert.strictEqual(request.maxTokens, 8192);
  });

  it('repairs the prefix folklore into the nine-cell probe, carrying AI0230 and the fix', async function () {
    const client = replaying(PREFIX_FOLKLORE, NINE_CELLS);
    const result = await createSpatialAuthor({ ...base, client, maxRepairs: 1 })
      .author('places near the centre', { sample: SAMPLE });
    assert.deepStrictEqual(result.value, NINE_CELLS);
    assert.strictEqual(client.sent.length, 2);
    const repair = String(client.sent[1].messages.at(-1).content);
    assert.match(repair, /AI0230/);
    assert.match(repair, /\$geohash-neighbours/);
    assert.match(repair, /\/rules\/0\/body\/\$where\/\$starts-with/, 'with the pointer');
  });

  it('repairs planar arithmetic into $distance, carrying AI0231', async function () {
    const client = replaying(PLANAR, SPATIAL_EXAMPLE);
    const result = await createSpatialAuthor({ ...base, client, maxRepairs: 1 })
      .author('the nearest cities', { sample: SAMPLE });
    assert.deepStrictEqual(result.value, SPATIAL_EXAMPLE);
    assert.match(String(client.sent[1].messages.at(-1).content), /AI0231/);
  });

  it('accepts the prefix document for a bucketing question — the gate reads the ask', async function () {
    const client = replaying(PREFIX_FOLKLORE);
    const result = await createSpatialAuthor({ ...base, client })
      .author('group the places by geohash cell', { sample: SAMPLE });
    assert.deepStrictEqual(result.value, PREFIX_FOLKLORE);
    assert.strictEqual(client.sent.length, 1);
  });

  it('proves running, not only compiling: a $$-escaped operand is caught on the real dataset', async function () {
    // a function replacement: in a string one, `$$` is the escape for `$`
    const escaped = JSON.parse(JSON.stringify(SPATIAL_EXAMPLE).replaceAll('"$.centre"', () => '"$$.centre"'));
    assert.strictEqual(compileGate({ compile: compileJsltStylesheet })(escaped), true, 'it compiles');
    const client = replaying(escaped, SPATIAL_EXAMPLE);
    const result = await createSpatialAuthor({ ...base, client, maxRepairs: 1 })
      .author('cities inside the region', { sample: SAMPLE });
    assert.deepStrictEqual(result.value, SPATIAL_EXAMPLE);
    assert.match(String(client.sent[1].messages.at(-1).content), /RUNTIME failure/);
  });

  it('answers the question it was asked, once the gates have passed', function () {
    // the end of the chain: the gates say it is the language and obeys
    // the rules, and the engine says what it means — on the CSV dataset
    assert.deepStrictEqual(run(SPATIAL_EXAMPLE).map((row) => row.name), ['Amsterdam', 'Utrecht', 'Rotterdam']);
  });
});
