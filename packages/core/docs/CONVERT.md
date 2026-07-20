# `@jarenjs/core/convert`

A tiny, data-driven engine for **pure, deterministic** quantity
conversion. Zero dependencies. Import the barrel (`@jarenjs/core/convert`)
or a single module.

## Static dimensional conversion — `registry.js` + `convert.js`

`convert(value, fromId, toId)` converts within a dimension, affine through
the dimension's base unit:

```
base   = value * factor + offset
target = (base - offset') / factor'
```

Most dimensions are linear (`offset` absent); **temperature** is affine
(°C/°F/K/°R). Digital storage ships both **binary** (KiB/MiB, 1024) and
**decimal** (KB/MB, 1000) prefixes. Dimensions: length, area, volume,
mass, temperature, time, speed, pressure, energy, power, data, datarate,
frequency, angle.

Helpers: `unitsOf(dimension)`, `dimensions()`, `dimensionOf(unitId)`.
Cross-dimension conversion throws a clear `RangeError`.

## Currency — `currency.js`

`convertCurrency(value, from, to, rateTable)` — the pure rate-table
primitive. Deterministic, side-effect free, and it **never fetches**: the
caller supplies the `{ code: rate }` table (or a `{ base, rates, at }`
envelope). It lives in core because the dividing line is **purity**, not
constant-vs-variable factors — this function is as pure as the fixed-factor
path, it just receives its factors as an argument. Only *fetching* the
table is impure, and that stays in the app component (see `@jarenjs/calc`).

Rate convention: `rate[code]` is the value of one unit of `code` in the
table's base currency, so `result = value * rate[from] / rate[to]`.
`currenciesOf(rateTable)` lists the codes.

## Not here

Number-base conversion (HEX/DEC/OCT/BIN) is `@jarenjs/core/math/word.js`
(`toBase`/`fromBase`); the converter's "base" category delegates to it.
Fuel-economy (mpg ↔ L/100km) is non-affine and outside this model.
