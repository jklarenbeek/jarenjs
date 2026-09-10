# Virtual geometry

Import `fixedRange`, `createVirtualAxis`, `virtualIndices` and
`logicalScrollOffset` from `@jarenjs/core/virtual`. This opt-in entry has no DOM,
view, app, database or worker dependency.

`fixedRange({count, size, viewport, offset=0, overscan=0})` returns a half-open
`{start,end,offset,extent}`. It clamps offsets to the logical extent, does constant
work, and returns an empty range for empty or hidden viewports. Count and overscan
are nonnegative safe integers; size is finite and positive. Invalid geometry
throws `RangeError`. Nonfinite offsets and viewports normalize to zero.

For a fixed axis the mounted base range has at most
`ceil(viewport / size) + 1 + 2 * overscan` rows, clamped by count. The extra row
covers fractional alignment. `virtualIndices(range,pins,count,pinBudget)` merges
unique valid pins and returns `budget-exhausted / pin-credits` when additional
pins exceed their limit. It never silently truncates the requested viewport.

`createVirtualAxis({count,estimateSize,maxMeasurements=256,maxBytes=32768})`
adds sparse sizes through `measure(index,key,size)`. Keys are stable strings.
The cache evicts oldest measurements and estimates their sizes again. Sorted
sparse entries and prefix summaries cost O(M) memory, where M is the measurement
credit, and rebuild only when measurements or identity mappings change. Position
lookups search those summaries; measured range lookup searches logical positions
without allocating or enumerating count items. Fixed ranges take the constant
path when no measurement is retained. `stats()` reports retained measurements,
accounted bytes and summaries; actual JS allocation overhead is measured separately.

`update({count,estimateSize,indexOf})` remaps retained keys after insertion,
deletion or reordering. An estimate change invalidates previous measurements.
`anchor(offset,keyAt,query)` captures key plus intra-row offset and query identity.
`restore(anchor,indexOf,query)` re-resolves the key, or uses the clamped previous
logical position when it disappeared; a changed query starts at zero. The index
in this transient fallback is never an entity identifier. The collection retains
this anchor before the host mutates source order.

`position`, `size`, `indexAt`, `extent`, `range`, `clear` and idempotent `dispose`
complete the axis API. A disposed axis retains no measurements or summaries.
`logicalScrollOffset` normalizes LTR, negative RTL, reverse RTL and default RTL
coordinates at a DOM adapter boundary. Core does not choose a browser scroll ceiling.
