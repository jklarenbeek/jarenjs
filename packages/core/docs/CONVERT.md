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

**Every linear factor is its exact definition.** The registry writes each
one as a rational built from the definitions it rests on (the
international inch, foot, yard and mile; the avoirdupois pound; standard
gravity; the US gallon of 231 cubic inches; the nautical mile of 1852 m), so
the US customary measures are fractions of the gallon (`floz` = gal/128,
`tbsp` = gal/256, `tsp` = gal/768), the knot is 1852/3600 m/s, `psi` is one
pound-force per square inch, `hp` is the mechanical horsepower (550 ft·lbf/s)
and `ps` the metric one (75 kgf·m/s). `cal` is the thermochemical calorie
(4.184 J, the basis of the food kilocalorie), `btu` the International Table
BTU (1055.05585262 J), `mmhg` the conventional millimetre of mercury, `t` the
metric tonne and `year` the Julian year (365.25 days). Angles carry their π:
`deg` is π/180, `grad` π/200, `turn` 2π. A unit's `factor` is the nearest
double of its definition, and between two units `convert` multiplies and
divides by their reduced exact ratio, so `convert(1, 'floz', 'tsp')` is `6`,
`convert(1, 'knot', 'kmh')` is `1.852` and `convert(90, 'deg', 'grad')` is
`100`, each rounded once. Temperatures keep the affine path.

*Upgrade: `floz`, `tbsp`, `tsp`, `knot`, `psi` and `hp` were held as decimals
rounded to nine to thirteen digits (`0.0295735296`, `0.0147867648`,
`0.00492892159`, `0.514444444`, `6894.757293168`, `745.699871582`); their
factors and every conversion through them now answer the exact definition
(`1 fl oz` is `29.5735295625 mL`, was `29.5735296`; `1 fl oz` is `6 tsp`, was
`6.0000000122`). Between two units that share a definition a conversion that
was a float product (`1 ft` → `in` is `12`, `1/3.6` for km/h) is now exactly
the ratio, which can move the last digit of a result.*

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
(`toBase`/`fromBase`), standalone — base is a notation, not a dimension,
so the converter has no "base" category.
Fuel-economy (mpg ↔ L/100km) is non-affine and outside this model.
