# Collection architecture

`@jarenjs/core/virtual` owns DOM-free range and sparse measurement math.
The collection engine owns vnode projection and key-based interaction, importing
only core/view. The component entry owns elements, frames and observers and maps
`dispose` to the view renderer's existing `unmount` hook.

The app range coordinator receives a structural provider from the host. Storage
adapters in linq/db never import app; neither core nor the collection engine
imports storage or workers. Source resources stay private to the coordinator.

`drag.js` owns serializable drag intent and generation-fenced authority replies.
The component drag adapter owns pointer capture, keyboard/touch activation,
client-coordinate hit testing, a portal overlay and bounded auto-scroll. It uses
collection lifecycle subscriptions and shared focus/pin budgets. DOM resources
never enter app state and the engine never mutates business data. Native layout
and capture paths are qualified by the three-engine browser matrix; the headless
state machine and collection ownership remain in the Node function audit.
