#!/usr/bin/env node
//@ts-check
/**
 * The retrieval corpus: a seeded ledger of memories with gold labels,
 * written into `benchmark/fixtures/retrieval-corpus.json` for
 * `benchmark/retrieval.js` to score retrieval policies against.
 *
 * Why generated rather than typed: the fixture's job is to be hard in a
 * KNOWN way. Every question names the memory ids that answer it, and the
 * memories around them are distractors built to defeat one cheap signal
 * each — the same tag with a different fact (so tag match alone cannot
 * pick the right record), and the same words with a different fact (so
 * word overlap alone cannot either). Hand-typing ten thousand of those
 * would be impossible, and hand-typing a hundred would make the
 * question easy.
 *
 * Why seeded: a benchmark whose corpus changes between runs cannot state
 * a delta, so the PRNG is mulberry32 with a fixed seed and the second
 * run of this script is byte-identical to the first — asserted by
 * `test/ai/retrieval-corpus.test.js`, which also proves the committed
 * fixture still agrees with the generator, so the corpus cannot rot.
 *
 * Why synthetic, said plainly: the statements are composed from twenty
 * topic vocabularies. They measure whether a retrieval POLICY can find
 * the right record among distractors — a mechanism — and say nothing
 * about whether any model understands language. The instrument's
 * published note repeats this beside every number.
 *
 *   node scripts/generate-retrieval-corpus.js           # check, exit 1 on drift
 *   node scripts/generate-retrieval-corpus.js --write   # rewrite the fixture
 *   node scripts/generate-retrieval-corpus.js --write --out PATH
 *
 * The shape:
 *   - `facts`: one distinct statement per fact, each with its topic and
 *     the id of the ONE memory that states it (its gold memory);
 *   - `memories`: ledger records `{ id, text, evidence, tags, at }` —
 *     the gold memories plus distractors, `at` spread over one synthetic
 *     year. The list is a PREFIX design: the first `sizes[0]` records are
 *     the small corpus and the whole list is the large one, and every
 *     gold memory sits inside the small prefix, so one question set
 *     scores both sizes;
 *   - `questions`: each names its gold memory ids — one, two or three,
 *     so recall@k is not trivially recall@1 — and a quarter of them never
 *     say their topic's name, which is the honest failure mode of any
 *     policy that starts from a tag.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { mulberry32, shuffle } from '@jarenjs/core/random';

const OUT = fileURLToPath(new URL('../benchmark/fixtures/retrieval-corpus.json', import.meta.url));

/** The corpus seed. Published beside every number the instrument prints. */
export const CORPUS_SEED = 20260825;

/** The two corpus sizes, as prefix lengths of `memories`. */
export const SIZES = [1000, 10000];

/** Facts per topic, and how they are asked: five questions with one gold
 * memory, two with two, one with three — twelve facts, eight questions,
 * every fact asked exactly once. */
const FACTS_PER_TOPIC = 12;
const QUESTION_SHAPE = [1, 1, 1, 1, 1, 2, 2, 3];

/** The synthetic year every `at` falls in. */
const YEAR_START = Date.UTC(2025, 0, 1);
const YEAR_SECONDS = 365 * 24 * 60 * 60;

//#region vocabularies

/**
 * Cross-cutting tags a memory may carry beside its topic. A question
 * that names one widens the incumbent's tag match (the ledger's tag
 * predicate is "any tag overlaps"), which is a behaviour worth scoring
 * rather than hiding.
 */
const SECONDARY_TAGS = ['windows', 'ci', 'browser', 'perf', 'release', 'docs', 'tests', 'network', 'memory', 'bun'];

/**
 * Twenty topics. Each statement is `subject predicate object`; the
 * subjects and objects are topic-specific so a lexical distractor built
 * from another topic's vocabulary shares words with exactly one fact's
 * subject. No phrase may contain a tag word — the generator asserts it —
 * so a question that omits its topic's name is genuinely tagless.
 * @type {Array<{ tag: string, subjects: string[], predicates: string[], objects: string[] }>}
 */
const TOPICS = [
  { tag: 'deploy',
    subjects: ['the staging rollout', 'the canary switch', 'the blue-green cutover', 'the hotfix train',
      'the nightly publish', 'the rollback script', 'the preview build', 'the tag push'],
    predicates: ['needs', 'waits for', 'fails without', 'is gated by'],
    objects: ['a WAL checkpoint', 'the migration lock', 'a warm cache', 'the health probe', 'a signed manifest',
      'the flag sweep', 'two approvals', 'a frozen lockfile', 'the smoke matrix', 'a drained queue'] },
  { tag: 'csv',
    subjects: ['the quoted-field reader', 'the header sniffer', 'the delimiter guess', 'the streaming writer',
      'the short-record repair', 'the BOM strip', 'the line-ending pass', 'the numeric coercion'],
    predicates: ['hangs on', 'was fixed by', 'is measured by', 'must not skip'],
    objects: ['an unterminated quote', 'the spectrum fixtures', 'a trailing comma', 'the wide-row corpus',
      'a lone carriage return', 'the escape table', 'an empty final line', 'the udsv comparison',
      'a mixed delimiter file', 'the eight-bit fallback'] },
  { tag: 'markdown',
    subjects: ['the link resolver', 'the fence scanner', 'the table parser', 'the entity decoder',
      'the emphasis pass', 'the list indent rule', 'the html filter', 'the footnote collector'],
    predicates: ['rejects', 'diverges on', 'is pinned by', 'depends on'],
    objects: ['a javascript scheme', 'the spec examples', 'a nested blockquote', 'the vnode renderer',
      'a hard line break', 'the marker directive', 'a bare autolink', 'the gfm tables',
      'a tab after the bullet', 'the entity list'] },
  { tag: 'mermaid',
    subjects: ['the flowchart head', 'the sequence lexer', 'the gantt scaler', 'the pie layout',
      'the class edge router', 'the state nester', 'the mindmap tree', 'the gitgraph lane'],
    predicates: ['draws', 'mislays', 'is sized by', 'was rewritten for'],
    objects: ['the subgraph frame', 'a dashed arrow', 'the font metrics stub', 'an unquoted label',
      'the edge label box', 'a self loop', 'the headless renderer', 'a loop block',
      'the jison comparison', 'an escaped pipe'] },
  { tag: 'validator',
    subjects: ['the dynamic ref walker', 'the format table', 'the unevaluated pass', 'the const check',
      'the pattern cache', 'the error collector', 'the compile step', 'the draft switch'],
    predicates: ['skips', 'was slowed by', 'answers', 'is tested by'],
    objects: ['a remote anchor', 'the official suite', 'two open cases', 'a recursive schema',
      'the ajv comparison', 'an unknown keyword', 'the sibling anyOf', 'a large enum',
      'the error path', 'an empty schema'] },
  { tag: 'jsonpath',
    subjects: ['the descendant walker', 'the filter compiler', 'the slice normalizer', 'the singular query rule',
      'the comparable hoist', 'the function table', 'the name selector', 'the wildcard step'],
    predicates: ['compiles', 'was sped up by', 'refuses', 'is covered by'],
    objects: ['the compliance suite', 'a negative step', 'the length function', 'an unquoted key',
      'the json-p3 comparison', 'a nested filter', 'the normalized path', 'a null comparison',
      'the type gate', 'an absolute anchor'] },
  { tag: 'flwor',
    subjects: ['the join planner', 'the group step', 'the order key', 'the let binding',
      'the window clause', 'the count clause', 'the return shaper', 'the where pushdown'],
    predicates: ['reorders', 'is limited by', 'was measured against', 'keeps'],
    objects: ['a nested loop', 'the hash join', 'an empty sequence', 'the fontoxpath comparison',
      'a stable sort', 'the ast gate', 'a lifted comparison', 'the type annotator',
      'an unbound name', 'the operator count'] },
  { tag: 'jslt',
    subjects: ['the template dispatcher', 'the mode switch', 'the identity rule', 'the apply step',
      'the authoring profile', 'the recursion guard', 'the match ranker', 'the output shaper'],
    predicates: ['chooses', 'was cut by', 'fails on', 'is pinned by'],
    objects: ['the deepest rule', 'a mode name clash', 'the jsonata comparison', 'an unmatched node',
      'the cheap-tier authoring', 'a copy rule', 'the profile size', 'an infinite apply',
      'the stylesheet schema', 'a missing default'] },
  { tag: 'geo',
    subjects: ['the point-in-polygon test', 'the haversine kernel', 'the bbox index', 'the geohash encoder',
      'the centroid rule', 'the wkt parser', 'the simplifier', 'the antimeridian split'],
    predicates: ['handles', 'loses to', 'was verified by', 'ignores'],
    objects: ['a shared edge', 'the turf comparison', 'a pole crossing', 'the flatbush index',
      'an unclosed ring', 'the neighbour cells', 'a measure dimension', 'the equivalence gate',
      'an empty collection', 'the sphere radius'] },
  { tag: 'charts',
    subjects: ['the incremental tick', 'the axis scaler', 'the legend builder', 'the pie labeler',
      'the stream adapter', 'the theme host', 'the tooltip rule', 'the bar stacker'],
    predicates: ['redraws', 'is bounded by', 'was rewritten by', 'keeps'],
    objects: ['ten thousand points', 'the wholesale comparison', 'a log axis', 'the colour ramp',
      'a missing series', 'the svg sink', 'an empty frame', 'the benchmark adapter',
      'a negative bar', 'the twelve types'] },
  { tag: 'forms',
    subjects: ['the field mapper', 'the grapheme counter', 'the session buffer', 'the blur commit',
      'the enum widget', 'the array editor', 'the error placer', 'the default filler'],
    predicates: ['eats', 'was fixed by', 'mirrors', 'refuses'],
    objects: ['a keystroke', 'the controlled editor', 'a nested array', 'the stylesheet',
      'an unknown format', 'the schema defaults', 'a combining mark', 'the session record',
      'a required flag', 'the widget key'] },
  { tag: 'fsm',
    subjects: ['the guard evaluator', 'the nested machine', 'the transition table', 'the dag scheduler',
      'the diagram projection', 'the effect runner', 'the app bridge', 'the pirate seed'],
    predicates: ['survives', 'is serialized by', 'was ported from', 'drops'],
    objects: ['a JSON round trip', 'the xstate comparison', 'an unguarded edge', 'the libero examples',
      'a cancelled run', 'the abort signal', 'an unknown event', 'the dataflow tax',
      'a parallel region', 'the studio seed'] },
  { tag: 'ledger',
    subjects: ['the write queue', 'the snapshot token', 'the id mint', 'the recall filter',
      'the tag predicate', 'the slot excerpt', 'the goal archive', 'the storage adapter'],
    predicates: ['refuses', 'was collapsed into', 'orders by', 'survives'],
    objects: ['an unknown member', 'the sequence scan', 'a caller-named id', 'the rollback point',
      'a concurrent batch', 'the localStorage slot', 'an unevidenced note', 'the query seam',
      'a sorted key list', 'the two-tab race'] },
  { tag: 'contract',
    subjects: ['the idempotency key', 'the dispatch table', 'the sse binding', 'the revision hash',
      'the local binding', 'the task mode', 'the error mapper', 'the precondition check'],
    predicates: ['claims', 'was raced by', 'answers', 'is capped by'],
    objects: ['a digest race', 'the fastify comparison', 'an in-progress reply', 'the canonical form',
      'a parked handler', 'the overflow status', 'an opaque body', 'the retry header',
      'a stale revision', 'the linger timer'] },
  { tag: 'sqlite',
    subjects: ['the wasm driver', 'the jsonb column', 'the derived index', 'the migration step',
      'the residual path', 'the pushdown planner', 'the strict table', 'the live capture'],
    predicates: ['materializes', 'was measured at', 'refuses', 'keeps'],
    objects: ['a stored column', 'the pouchdb comparison', 'a virtual function', 'the two-run check',
      'an unknown kind', 'the backfill pass', 'a blob bind', 'the explain output',
      'an unregistered function', 'the opfs pool'] },
  { tag: 'orm',
    subjects: ['the graph loader', 'the unit of work', 'the keyset pager', 'the entity mapper',
      'the statement counter', 'the relation walker', 'the batch insert', 'the cold start'],
    predicates: ['issues', 'loses to', 'was counted by', 'batches'],
    objects: ['one statement', 'the prisma comparison', 'a round trip', 'the drizzle route',
      'an offset scan', 'the kysely contrast', 'a nested member', 'the warm engine',
      'a validated row', 'the second runtime table'] },
  { tag: 'playground',
    subjects: ['the engine picker', 'the error locator', 'the share link', 'the kb inset',
      'the deep next trick', 'the example loader', 'the output pane', 'the run button'],
    predicates: ['shows', 'was retired by', 'hides', 'locates'],
    objects: ['a stale result', 'the three location families', 'an overflowing pane', 'the studio',
      'a syntax error', 'the seam', 'an empty document', 'the mobile keyboard',
      'a long output', 'the example set'] },
  { tag: 'locales',
    subjects: ['the arabic pack', 'the plural rule', 'the date formatter', 'the bidi marker',
      'the number grouper', 'the message catalog', 'the fallback chain', 'the screenshot check'],
    predicates: ['needs', 'was verified by', 'flips', 'drops'],
    objects: ['a right-to-left screenshot', 'the eleven packs', 'a zero form', 'the grapheme table',
      'an isolate mark', 'the fallback pack', 'a missing key', 'the currency sign',
      'a narrow space', 'the plural category'] },
  { tag: 'emit',
    subjects: ['the lazy cli', 'the model writer', 'the ddl printer', 'the typescript fixture',
      'the consumer check', 'the header banner', 'the enum spelling', 'the import sorter'],
    predicates: ['prints', 'was pinned by', 'refuses', 'drifts on'],
    objects: ['a generated header', 'the packed consumer', 'an unsorted import', 'the fixture diff',
      'a reserved word', 'the strict flag', 'an unknown type', 'the tree-shaking check',
      'a nullable column', 'the drift gate'] },
  { tag: 'website',
    subjects: ['the service worker', 'the nav dropdown', 'the assistant store', 'the bench page',
      'the data studio', 'the motion sweep', 'the design tokens', 'the living hero'],
    predicates: ['caches', 'is guarded by', 'was bumped by', 'renders'],
    objects: ['a stale shell', 'the predeploy check', 'an owner lock', 'the suite table',
      'a posix path', 'the timing guard', 'an unkeyed widget', 'the cache name',
      'a dark theme', 'the census count'] },
];

//#endregion

/** Lower-case word tokens of a text — the same split the harness uses
 * to extract tags from a question. */
export function tokens(text) {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 0);
}

/** A statement, capitalized and terminated. */
const sentence = (subject, predicate, object) =>
  `${subject.charAt(0).toUpperCase()}${subject.slice(1)} ${predicate} ${object}.`;

/** One uniform pick from a list. */
const pick = (random, list) => list[Math.floor(random() * list.length)];

/** Zero to two secondary tags, distinct. */
function secondaryTags(random) {
  const count = Math.floor(random() * 3);
  const out = [];
  while (out.length < count) {
    const tag = pick(random, SECONDARY_TAGS);
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

/** An RFC 3339 timestamp somewhere in the synthetic year, whole seconds. */
const timestamp = (random) =>
  new Date(YEAR_START + Math.floor(random() * YEAR_SECONDS) * 1000).toISOString();

/** A file-shaped evidence pointer under the topic. */
const evidenceFor = (random, topic) => `notes/${topic}/${1 + Math.floor(random() * 400)}.md`;

/**
 * The tag set every phrase must avoid, so "no topic word in the
 * question" means exactly that.
 */
function assertPhrasesCarryNoTag(tagSet) {
  for (const topic of TOPICS) {
    for (const phrase of [...topic.subjects, ...topic.predicates, ...topic.objects]) {
      for (const token of tokens(phrase)) {
        if (tagSet.has(token))
          throw new Error(`vocabulary phrase '${phrase}' (${topic.tag}) contains the tag word '${token}'`);
      }
    }
  }
}

/**
 * Generate the corpus for a seed. Pure: the same seed always yields the
 * same object, and nothing here reads the clock or `Math.random`.
 * @param {number} [seed]
 */
export function generateRetrievalCorpus(seed = CORPUS_SEED) {
  const random = mulberry32(seed);
  const tagSet = new Set([...TOPICS.map((t) => t.tag), ...SECONDARY_TAGS]);
  assertPhrasesCarryNoTag(tagSet);

  // -- facts: distinct statements, twelve per topic -----------------------
  /** @type {Array<{ topic: number, subject: string, text: string }>} */
  const facts = [];
  const statements = new Set();
  TOPICS.forEach((topic, index) => {
    while (facts.filter((f) => f.topic === index).length < FACTS_PER_TOPIC) {
      const subject = pick(random, topic.subjects);
      const text = sentence(subject, pick(random, topic.predicates), pick(random, topic.objects));
      if (statements.has(text)) continue;
      statements.add(text);
      facts.push({ topic: index, subject, text });
    }
  });

  // -- memories: the gold record per fact, then distractors ---------------
  /** @type {Array<{ text: string, evidence: string, tags: string[], at: string, fact: number | null }>} */
  const records = facts.map((fact, index) => ({
    text: fact.text,
    evidence: evidenceFor(random, TOPICS[fact.topic].tag),
    tags: [TOPICS[fact.topic].tag, ...secondaryTags(random)],
    at: timestamp(random),
    fact: index,
  }));

  /** A same-tag distractor: the topic's own vocabulary, a statement no
   * fact makes. Tag match finds it as readily as the gold record. */
  function sameTagDistractor() {
    for (;;) {
      const index = Math.floor(random() * TOPICS.length);
      const topic = TOPICS[index];
      const text = sentence(pick(random, topic.subjects), pick(random, topic.predicates), pick(random, topic.objects));
      if (statements.has(text)) continue;
      statements.add(text);
      return { text, evidence: evidenceFor(random, topic.tag),
        tags: [topic.tag, ...secondaryTags(random)], at: timestamp(random), fact: null };
    }
  }

  /** A lexical distractor: a fact's SUBJECT under another topic's
   * predicate, object and tag. Word overlap finds it; the tag does not. */
  function lexicalDistractor() {
    for (;;) {
      const fact = pick(random, facts);
      const index = Math.floor(random() * TOPICS.length);
      if (index === fact.topic) continue;
      const topic = TOPICS[index];
      const text = sentence(fact.subject, pick(random, topic.predicates), pick(random, topic.objects));
      if (statements.has(text)) continue;
      statements.add(text);
      return { text, evidence: evidenceFor(random, topic.tag),
        tags: [topic.tag, ...secondaryTags(random)], at: timestamp(random), fact: null };
    }
  }

  const distractor = () => (random() < 0.5 ? sameTagDistractor() : lexicalDistractor());

  // the small corpus: every gold record plus distractors, shuffled so an
  // id says nothing about which is which inside the prefix
  while (records.length < SIZES[0]) records.push(distractor());
  shuffle(random, records);
  // the large corpus: the same prefix, then more distractors
  while (records.length < SIZES[SIZES.length - 1]) records.push(distractor());

  const width = String(records.length).length;
  const memories = records.map((record, index) => ({
    id: `mem-${String(index + 1).padStart(width, '0')}`,
    text: record.text,
    evidence: record.evidence,
    tags: record.tags,
    at: record.at,
  }));
  /** @type {string[]} */
  const goldIds = [];
  records.forEach((record, index) => {
    if (record.fact !== null) goldIds[record.fact] = memories[index].id;
  });

  // -- questions: every fact asked exactly once -----------------------------
  /** @type {Array<{ id: string, text: string, topic: string, facts: string[], gold: string[] }>} */
  const questions = [];
  TOPICS.forEach((topic, index) => {
    const own = shuffle(random, facts.map((f, i) => (f.topic === index ? i : -1)).filter((i) => i >= 0));
    // a multi-gold question names distinct subjects — twelve facts over
    // eight subjects share some, and "about X and X" would be a question
    // with one subject and two answers. Groups are drawn largest first
    // from the shuffled pool so the singles take whatever is left.
    const groups = [];
    for (const count of [...QUESTION_SHAPE].sort((a, b) => b - a)) {
      /** @type {number[]} */
      const asked = [];
      for (const i of own) {
        if (asked.length === count) break;
        if (asked.every((j) => facts[j].subject !== facts[i].subject)) asked.push(i);
      }
      if (asked.length !== count)
        throw new Error(`topic '${topic.tag}' cannot ask ${count} distinct subjects from its remaining facts`);
      for (const i of asked) own.splice(own.indexOf(i), 1);
      groups.push(asked);
    }
    for (const asked of groups.reverse()) {
      const subjects = asked.map((i) => facts[i].subject);
      const list = subjects.length === 1 ? subjects[0]
        : `${subjects.slice(0, -1).join(', ')} and ${subjects[subjects.length - 1]}`;
      const roll = random();
      let text;
      if (roll < 0.25) {
        // tagless: the topic is never named, so a tag-first policy has
        // nothing to start from
        text = `What did we learn about ${list}?`;
      }
      else if (roll < 0.45) {
        // a secondary tag beside the topic widens the incumbent's match
        const first = records.find((r) => r.fact === asked[0]);
        const extra = (first?.tags ?? []).slice(1);
        text = extra.length === 0
          ? `About ${topic.tag}: what did we learn about ${list}?`
          : `About ${topic.tag} and ${pick(random, extra)}: what did we learn about ${list}?`;
      }
      else if (roll < 0.7) {
        text = `Which ${topic.tag} note covers ${list}?`;
      }
      else {
        text = `About ${topic.tag}: what did we learn about ${list}?`;
      }
      questions.push({
        id: `q-${String(questions.length + 1).padStart(3, '0')}`,
        text,
        topic: topic.tag,
        facts: asked.map((i) => `f-${String(i + 1).padStart(3, '0')}`),
        gold: asked.map((i) => goldIds[i]),
      });
    }
  });

  return {
    seed,
    sizes: [...SIZES],
    topics: TOPICS.map((t) => t.tag),
    tags: [...tagSet].sort(),
    facts: facts.map((fact, index) => ({
      id: `f-${String(index + 1).padStart(3, '0')}`,
      topic: TOPICS[fact.topic].tag,
      text: fact.text,
      memory: goldIds[index],
    })),
    questions,
    memories,
  };
}

/**
 * The fixture text: one record per line, so a regeneration diffs by
 * record and the file stays greppable at ten thousand memories.
 * @param {ReturnType<typeof generateRetrievalCorpus>} corpus
 */
export function serializeCorpus(corpus) {
  const lines = (list) => list.map((item) => `  ${JSON.stringify(item)}`).join(',\n');
  return '{\n'
    + ` "seed": ${corpus.seed},\n`
    + ` "sizes": ${JSON.stringify(corpus.sizes)},\n`
    + ` "topics": ${JSON.stringify(corpus.topics)},\n`
    + ` "tags": ${JSON.stringify(corpus.tags)},\n`
    + ` "facts": [\n${lines(corpus.facts)}\n ],\n`
    + ` "questions": [\n${lines(corpus.questions)}\n ],\n`
    + ` "memories": [\n${lines(corpus.memories)}\n ]\n`
    + '}\n';
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const outIndex = argv.indexOf('--out');
  const out = outIndex >= 0 ? resolve(argv[outIndex + 1]) : OUT;
  const corpus = generateRetrievalCorpus();
  const text = serializeCorpus(corpus);
  const summary = `${corpus.memories.length} memories, ${corpus.facts.length} facts, ${corpus.questions.length} questions`;
  if (argv.includes('--write')) {
    writeFileSync(out, text);
    console.log(`retrieval corpus: ${summary} written to ${out}`);
  }
  else {
    let current = null;
    try {
      current = readFileSync(out, 'utf8');
    }
    catch {
      current = null;
    }
    if (current === text) {
      console.log(`retrieval corpus: ${summary}, the committed fixture agrees.`);
    }
    else {
      console.error('retrieval corpus: the committed fixture does not match what the generator produces now.');
      console.error('Run `node scripts/generate-retrieval-corpus.js --write` and read the diff before keeping it.');
      process.exitCode = 1;
    }
  }
}
