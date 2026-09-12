//@ts-check
/** Isolated Data state; the boot operation seeds the editable documents. */
export function createDataState() {
  return {
      status: 'boot',          // 'boot' | 'ready' | 'error'
      boot: null,              // the terminal boot failure { code: 'DATA_BOOT', stage, message }, or null
      topology: '—',           // 'owner' | 'client'
      vfs: '—',                // 'opfs-sahpool' | 'memory'
      version: '',
      capture: '—',            // 'journal' on wasm (sessions not adapted)
      operators: [],           // registered operator vocabulary (math/finance/stats packs)
      pushableOperators: [],   // the subset pushed to SQLite as deterministic UDFs
      refusal: null,           // the JD2061 second-writer message, if any
      modelText: '',           // the editable model document (JSON)
      queryText: '',           // the editable query document (JSON)
      // the collection every effect works on and the key pointer its
      // model declares — the model pane is editable, so both move with
      // the model rather than being named anywhere
      collection: '',
      keyPointer: '/id',
      rows: [],                // the whole collection, last read
      results: [],             // the last query() result
      explain: null,           // the last explain() { sql, params, indexes, residual }
      live: { rows: [], seq: null, regs: null },
      // the insert field's buffer. A controlled input whose value is not
      // published per keystroke is erased by the next render, and this
      // page renders on every live-query event — so the title had to
      // live in state, not only in the DOM.
      insertDraft: '',
      migration: null,         // the last planned/applied migration report
      // the spatial corpus run through THIS tab's store as the third
      // executor (data.oracle, one throwaway store per entry): null until
      // asked, then { status: 'running' } and the report
      oracle: null,
      // the spatial round trip (CSV → stylesheet → meta-schema → a
      // throwaway store with derived spatial indexes → a linq $within →
      // explain() → a map), run from the fourth card: the editable CSV,
      // and the last report (null until asked, then { status, … })
      trip: { csv: '', report: null },
      error: null,
      // the phone layout: which single card shows (store | query | live |
      // trip). Query is the default — it is what a reader of this page
      // came for.
      mobilePane: 'query',
    };
}
