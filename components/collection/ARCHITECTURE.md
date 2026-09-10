# Collection architecture

`@jarenjs/core/virtual` owns DOM-free range and sparse measurement math.
The collection engine owns vnode projection and key-based interaction, importing
only core/view. The component entry owns elements, frames and observers and maps
`dispose` to the view renderer's existing `unmount` hook.

The app range coordinator receives a structural provider from the host. Storage
adapters in linq/db never import app; neither core nor the collection engine
imports storage or workers. Source resources stay private to the coordinator.
