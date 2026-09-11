//@ts-check
/** Browser integration over the reusable editor, collection and durable command. */
import { mountRuleEditor } from '@jarenjs/rules/component';
import { mountCollection } from '@jarenjs/collection/component';
import { createDomRenderer } from '@jarenjs/view';
import { openRuleExample, savedRule, ruleRowSchema } from '../examples/reviewed-rules.js';

/** Driver injection lets the same example run in browser and portable lifecycle tests. */
export function mountRulesDemo(host, options = {}) {
  const document = host.ownerDocument;
  const render = createDomRenderer(host, { document });
  let disposed = false, example = null, editor = null, collection = null;
  render(['section', {}, ['h2', {}, 'Saved formulas and reviewed rules'],
    ['p', {}, 'Preview is read-only. Commit checks the saved rule, current rows and authority in a transaction. Drafts may be edited freely; changing the saved rule requires a separate application command.'],
    ['div', { 'data-rules-editor': '' }], ['h3', {}, 'Current inventory'], ['div', { 'data-rules-collection': '' }], ['p', { role: 'status', 'data-rules-host-status': '' }, 'Opening local database…']]);
  const status = host.querySelector('[data-rules-host-status]');
  const ready = (async () => {
    let driver = options.driver;
    if (!driver) {
      const [{ default: init }, { wasmDriver, sqlite3Handle }] = await Promise.all([import('@sqlite.org/sqlite-wasm'), import('@jarenjs/db/wasm')]);
      driver = wasmDriver(sqlite3Handle(await init()));
    }
    example = await openRuleExample({ driver });
    if (disposed) { await example.close(); return; }
    let rows = await example.rows();
    collection = mountCollection(host.querySelector('[data-rules-collection]'), { count: rows.length, keyAt: (i) => rows[i]?.id,
      indexOf: (id) => rows.findIndex((row) => row.id === id), getItem: (i) => rows[i], height: 264, rowSize: 44, columnCount: 3, columnSize: 150,
      label: 'Current inventory', renderCell: (row, column) => column === 0 ? row.id : column === 1 ? `Amount: ${row.amount}` : `Revision: ${row.revision}` });
    editor = mountRuleEditor(host.querySelector('[data-rules-editor]'), { text: JSON.stringify(savedRule, null, 2), schema: ruleRowSchema,
      pageSize: 10, writableFields: ['/amount'], preview: (text) => example.preview(text), command: async (request) => {
        const result = await example.command.execute(request);
        rows = await example.rows();
        if (!disposed) collection.update({ count: rows.length });
        return result;
      } });
    status.textContent = 'Local database ready. Preview writes zero inventory rows.';
  })().catch((error) => { if (!disposed) status.textContent = `Example unavailable: ${error.message}`; });
  let teardown;
  return { ready,
    dispose() {
      if (teardown) return teardown;
      disposed = true; editor?.dispose(); collection?.dispose(); render.destroy();
      teardown = ready.then(() => example?.close()); return teardown;
    },
  };
}
