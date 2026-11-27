//@ts-check
/**
 * The project host's query and JSLT results and the data studio's
 * disagreement line speak the reader's catalog: the stat cards, the result
 * titles, a JSON refusal and the empty sequence used to be English typed
 * into the module, whatever language the reader chose. English output is
 * the same text it was.
 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { compileMessageCatalog } from '@jarenjs/core/message';
import { nl, de } from '@jarenjs/locales';
import { servePort } from '@jarenjs/contract/port';
import { nodeDriver } from '@jarenjs/db/node';
import { createDataHandlers, dataContract } from '@jarenjs/studio/data/host';
import { runProjectFile } from '../../packages/website/src/boundaries/project.js';

const file = (/** @type {string} */ name, /** @type {string} */ kind, /** @type {string} */ text) => ({ name, kind, text });
const data = file('data.json', 'data', '{"a":[1,2,3]}');
/** The titles, values and texts a run renders, its timings left out. @param {any} result */
const words = (result) => result.nodes.map((/** @type {any} */ node) => (node.kind === 'cards'
  ? node.items.map((/** @type {any} */ item) => item.title)
  : [node.kind, node.title, node.text ?? node.message]));
/** @param {string} kind @param {string} text @param {any} [messages] */
const run = (kind, text, messages) => words(runProjectFile({ files: [file('f.json', kind, text), data] }, 'f.json', { messages }));

const QUERY = '{"$for":{"x":"$.a[*]"},"$return":"$x"}';
const EMPTY = '{"$for":{"x":"$.none[*]"},"$return":"$x"}';

it('renders a query result, an empty one and a JSON refusal in English as before', () => {
  assert.deepEqual(run('query', QUERY), [['Items', 'Compile', 'Run'], ['code', 'Result', '[\n  1,\n  2,\n  3\n]']]);
  assert.deepEqual(run('query', EMPTY), [['Items', 'Compile', 'Run'], ['code', 'Result', '(empty sequence)']]);
  assert.deepEqual(run('query', '{oops'), [['error', 'Invalid JSON', "query: Expected property name or '}' in JSON at position 1 (line 1 column 2)"]]);
  assert.deepEqual(run('jslt', '[]'), [['Compile', 'Transform'], ['code', 'Output', '{\n  "a": [\n    1,\n    2,\n    3\n  ]\n}']]);
});

it('renders them in the reader\'s catalog', () => {
  const dutch = compileMessageCatalog(nl);
  assert.deepEqual(run('query', EMPTY, dutch), [['Items', 'Compileren', 'Uitvoeren'], ['code', 'Resultaat', '(lege sequentie)']]);
  assert.deepEqual(run('query', '{oops', dutch)[0].slice(0, 2), ['error', 'Ongeldige JSON']);
  assert.deepEqual(run('jslt', '[]', dutch).map((row) => row.slice(0, 2)), [['Compileren', 'Transformeren'], ['code', 'Uitvoer']]);
  const german = compileMessageCatalog(de);
  assert.deepEqual(run('query', QUERY, german)[0], ['Elemente', 'Kompilieren', 'Ausführen']);
  // a function answering the current catalog is read at the run, as the schema branch reads it
  assert.deepEqual(run('query', QUERY, () => german)[0], ['Elemente', 'Kompilieren', 'Ausführen']);
});

it('writes a disagreement line, and the empty sequence it names, in the reader\'s catalog', async (t) => {
  const { createDataRuntime } = await import('@jarenjs/studio/data');
  const model = { $model: '0.1', collections: { rows: { schema: { type: 'object', properties: { id: { type: 'string' }, value: { type: 'integer' } } }, key: '/id' } } };
  const query = [{ $for: { row: '$[*]' }, $return: '$row' }];
  const none = { $for: { r: '$[*]' }, $where: false, $return: '$r' };
  const documents = [{ id: 'source', value: 2 }];
  /** @param {any} messages */
  const disagreements = async (messages) => {
    const table = createDataHandlers({
      init: async () => ({ topology: 'memory', vfs: 'memory', version: '3' }),
      makeDriver: () => nodeDriver(), makeScratchDriver: () => nodeDriver(), path: () => ':memory:',
      vfs: () => 'memory', durable: () => false, unlink() {}, announce() {}, operators: undefined,
    });
    const { port1, port2 } = new MessageChannel();
    const server = servePort(dataContract, table.handlers, { channel: port1 });
    const { openPortClient } = await import('@jarenjs/contract/port');
    const client = openPortClient(dataContract, { channel: port2 });
    const request = async (/** @type {any} */ op, /** @type {any} */ input) => {
      const result = await client.invoke(op, input);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    };
    const events = /** @type {any[]} */ ([]);
    const runtime = createDataRuntime({ model, query, lifecycleTarget: {}, messages, corpus: async () => ({ ok: true, value: {
      source: 'fixture', collection: 'rows', mappings: { plain: model }, skipped: [], entries: [
        { name: 'recorded-empty', documents, query, empty: true },
        { name: 'answered-empty', documents, query: none, expected: documents },
        // a query the store refuses is a disagreement too
        { name: 'refused', documents, query: { $nope: 1 }, expected: documents },
      ],
    } }), transport: () => ({ boot: () => request('data.init', null), request, bounded: (/** @type {any} */ _stage, /** @type {any} */ work) => work(),
      subscribe: (/** @type {any} */ input, /** @type {any} */ handlers) => client.subscribe('data.live', input, handlers),
      notices() {}, faults() {}, settled() {}, close() { client.close(); },
    }) });
    t.after(async () => { runtime.dispose(); server.close(); port1.close(); port2.close(); await table.dispose(); });
    const dispatch = (/** @type {string} */ name, /** @type {any} */ payload) => events.push({ name, payload });
    await runtime.effects['data-boot']({}, dispatch);
    runtime.effects['data-oracle']({}, dispatch);
    for (let n = 0; n < 200; n++) {
      const done = events.find((event) => event.name === 'data/oracle' && event.payload.status === 'done');
      if (done) return done.payload.disagreements;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return assert.fail('the corpus did not settle');
  };
  const refusal = 'operation data.oracle failed with db';
  const english = await disagreements(undefined);
  assert.deepEqual(english, [
    `sqlite (plain) disagreed on recorded-empty — query ${JSON.stringify(query)}: recorded the empty sequence, answered ${JSON.stringify(documents)}`,
    `sqlite (plain) disagreed on answered-empty — query ${JSON.stringify(none)}: recorded ${JSON.stringify(documents)}, answered the empty sequence`,
    `sqlite (plain) disagreed on refused — query {"$nope":1}: refused — ${refusal}`,
  ]);
  const dutch = await disagreements(compileMessageCatalog(nl));
  assert.deepEqual(dutch, [
    `sqlite (plain) week af bij recorded-empty — query ${JSON.stringify(query)}: vastgelegd de lege sequentie, geantwoord ${JSON.stringify(documents)}`,
    `sqlite (plain) week af bij answered-empty — query ${JSON.stringify(none)}: vastgelegd ${JSON.stringify(documents)}, geantwoord de lege sequentie`,
    `sqlite (plain) week af bij refused — query {"$nope":1}: geweigerd — ${refusal}`,
  ]);
  const german = await disagreements(compileMessageCatalog(de));
  assert.deepEqual(german, [
    `sqlite (plain) wich bei recorded-empty ab — Abfrage ${JSON.stringify(query)}: aufgezeichnet die leere Sequenz, geantwortet ${JSON.stringify(documents)}`,
    `sqlite (plain) wich bei answered-empty ab — Abfrage ${JSON.stringify(none)}: aufgezeichnet ${JSON.stringify(documents)}, geantwortet die leere Sequenz`,
    `sqlite (plain) wich bei refused ab — Abfrage {"$nope":1}: abgelehnt — ${refusal}`,
  ]);
});
