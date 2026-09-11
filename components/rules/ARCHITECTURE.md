# Rules component architecture

`src/index.js` is the DOM-free draft/review controller. It imports core JSON
snapshot helpers and receives preview/command functions structurally. It owns
no query evaluator, database adapter, transaction, ledger or virtual range engine.

`src/component/index.js` builds schema field guidance through forms and renders
through view. Input updates the authoritative draft immediately; independent
preview publication never replaces typed text or its caret. Review pages only
present a bounded portion of the plan. Selection lives by immutable change IDs.
The existing app widget lifecycle owns mounting and disposal. CSS binds host
light/dark theme tokens.

The host composes json/formula, json/rules, contract/command and linq/db receipts.
It reads current state and revalidates the plan inside one existing transaction.
The website supplies neutral application declarations and an independent virtual
inventory grid, while all reusable UI remains in this workspace.
