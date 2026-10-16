# `@jarenjs/core/math`

Zero-dependency numeric primitives. Static methods on `Float64`/`Int32`/
`Vec2f64`/`Vec3f64`, free `mathf64_*`/`mathi32_*` aliases and constants,
plus the newer subpath modules below. Import the barrel
(`@jarenjs/core/math`) or a single module (`@jarenjs/core/math/word`).

## Transcendental completeness — `float64.js`

Constants `mathf64_E`, `mathf64_LN2`, `mathf64_LN10`, `mathf64_PHI`.
Free aliases `mathf64_log`, `mathf64_log2`, `mathf64_log10`, `mathf64_exp`,
`mathf64_expm1`, `mathf64_tan`, `mathf64_acos`, `mathf64_atan`,
`mathf64_sinh`, `mathf64_cosh`, `mathf64_tanh`, `mathf64_cbrt`,
`mathf64_hypot`, `mathf64_sign`.

Statics on `Float64`: `factorial(n)` (exact for integers, `gamma(n+1)`
otherwise), `gamma(x)` (Lanczos, whole real line), `hypot(...args)`,
`roundTo(value, digits)` (decimal places, by rounding the scaled double
`value · 10^digits` half up — fast, and not exact: `roundTo(2.675, 2)` is
2.68 though the double is 2.67499…; `roundExact(x, precision, mode)` from
`decimal.js` rounds the exact value, half up or half to even),
`roundToPrecision(value, digits)` (significant figures — the numeric
value of `toPrecision`, without its exponential string formatting),
`nthroot(x, n)` (odd roots of negatives), `sign(x)`,
`logBase(base, x)`, `cosHp(r)` (a high-precision polynomial cosine).

### Range remapping — `remap`

The free export `remap(v, smin, smax, dmin, dmax)` is the one linear remap of
`v` from `[smin, smax]` to `[dmin, dmax]`: `dmin + t·(dmax - dmin)` with
`t = (v - smin)/(smax - smin)`. A degenerate source range (`smax === smin`)
collapses to `dmin` instead of dividing by zero, so a constant-valued axis still
maps to a drawable coordinate, and an inverted destination range works, which is
what screen-space y-flips need. Use it for any value/screen interpolation.

`Float64.norm(value, min, max)` is the bare normalization to `[0, 1]` that
`remap` performs internally; reach for it when you want the fraction itself
rather than a mapped coordinate.

## Word math — `word.js`

BigInt fixed-width integers for programmer-calculator mode. `toWord(value,
bits, signed)` masks and sign-extends into an 8/16/32/64-bit word;
`wAnd/wOr/wXor/wNot/wShl/wShr/wRol/wRor/wMod` operate at a width (a shift
count wraps with it, a negative one counting from the top; `wShl(1n, -1n)` used
to shift the other way and answer `0n`);
`toBase(int, radix, {group, sep, pad, upper})` and `fromBase(str, radix)`
(prefix-aware: `0x`/`0o`/`0b`) are the radix string I/O.

## Root finders — `solve.js`

Domain-free `newtonRaphson(f, df, x0, opts)`, `bisect(f, a, b, opts)`,
`secant(f, x0, x1, opts)`. Each returns `{ root, iterations, converged }`
and never throws on non-convergence. `centralDifference(f, h = 1e-6)` is
the derivative to hand Newton when `f` has none in closed form,
`(f(x + h) − f(x − h)) / 2h`. `@jarenjs/core/finance` builds
`irr`/`rate` (and the bond yield) on top.

## 3D kernel — `mat4.js` + `project.js`

`Mat4` (column-major `Float64Array(16)`): `identity`, `multiply`,
`rotationX/Y/Z`, `translation`, `scaling`, `ortho`, `perspective`,
`transformPoint`. `project3dTo2d(point3, mat, viewport)` maps a point to
SVG pixels (Y flipped); `surfaceNormal(a, b, c)` returns the face normal
as a `Vec3f64`. Reusable for any 3D projection (the x·y·z plotter is the
first consumer; Mermaid draws no 3D and does not use it).

## Number formatting — `format.js`

`formatNumber(value, { notation:'auto'|'fixed'|'sci'|'eng', precision,
group, radix, decimal, decimalFormat })` and radix-aware
`parseNumber(str, { radix, decimalFormat })` (recognizes `0x`/`0o`/`0b`
prefixes, grouping separators and scientific notation; returns `NaN` on
failure). Radix I/O delegates to `word.js`.

**A language's numbers.** Without `decimalFormat`, `parseNumber` reads
English: `.` is the decimal point and every `,`, `_` and space is dropped as
grouping wherever it stands, so decimal-comma text misreads (`'3,45'` is
345, `'1.234,5'` is 1.2345, `'1,23'` is 123). `decimalFormat` takes the
record `compileNumberLocale(pack).decimalFormat` of `@jarenjs/locales`
compiles (any object with `decimalSeparator` and `groupingSeparator`, and
optionally `minusSign`, `zeroDigit`, `exponentSeparator`, `infinity` and
`NaN`), so core carries no locale data. Under it a text has one reading:
an optional `+` or minus sign (the record's, `-` or `−`), an integer part
written without grouping or with the record's grouping separator before
every three digits after a leading group of one to three, an optional
fraction after the record's decimal separator, an optional exponent (the
record's separator, `e` or `E`), digits ASCII or the record's family.
Anything else is `NaN`, never a guess: under Dutch `'1.234,5'` is 1234.5,
`'3,45'` is 3.45 and `'10.000'` is 10000, while `'1,2,3'`, `'1.23'` and
`'3.45'` are `NaN`; under English `'1,234.5'` is 1234.5 and `'3,45'` is
`NaN`. Only the record's own grouping character is read: French groups
with U+202F, and `'1 234,5'` written with an ASCII space is `NaN`.
`formatNumber` writes the text the same record reads back (the round trip
is tested under every shipped pack): its separators (`group: true` takes
the record's), minus sign, digits, exponent separator and the words for
infinity and NaN; grouping falls every three digits, so Spanish 1234
groups as `'1.234'` although Spanish writes `1234` (CLDR's minimum
grouping digits are not applied; the text still reads back as 1234). A
record that cannot read one way — separators empty, equal or holding a
digit, a zero digit that is no digit family's zero — is a `TypeError`. A
price with its currency sign in a fixed place is a picture for
`$format-number` of `@jarenjs/json` under the same record (`'€ #.##0,00'`
writes `'€ 1.234,50'`). `isDigitZero(codePoint)` answers whether a code
point is the zero of a decimal digit family, the check both the record
here and `$format-number`'s decimal formats make.
`numberSyntax({ decimal, group, minus, zero, exponent }, { plus, exponent })`
is that one reading as regular-expression source, unanchored, with its
capturing groups counted (`groups`) and a `read(match)` that answers the
written digits in ASCII (`negative`, `whole`, `fraction`, `exponent`).
`parseNumber` reads a whole text by it; `$quantity` of `@jarenjs/json`
finds a number in free text by it with `plus: false` and
`exponent: false`, so under Dutch `'1,5E3'` is 1500 here while `'1,5E3 g'`
holds no quantity, and keeps the written digits for its exact unit
conversion. It takes the characters as given: each caller checks its own
record first.
`Int32` and `Vec2i32` wrap every product to int32 exactly (`Math.imul`), so
`Int32.dot(2147483647, 0, 2147483645, 0)` is `3`, the low 32 bits of the true
product; a double product lost them past 2^53. The in-place `iadd`, `iadds`,
`isub`, `isubs`, `imul` and `imuls` wrap to int32 as well. `Vec2i32.cross3`
now returns an int32 too: it used to return the exact double, so coordinates
around 1e5 (`(0,0)`, `(1e5,0)`, `(0,1e5)`: 1e10 before, 1410065408 now) change
the answer, and the sign can flip for coordinates from about 46341 up.
`Int32.lerp(norm, min, max)` is `min + (max - min) * norm` and `Vec2f64.lerp(norm, a, b)`
is `a + norm * (b - a)`; both multiplied the span by `norm + base` before, which agreed
with these only from a base of 0 (`Int32.lerp(5, 3, 13)` was 80, it is 53). `Float64.fib`
and `Float64.factorial` answer `Infinity` for an argument past the largest double,
`Infinity` and `1e300` included (they looped for ever).
Engineering notation keeps the mantissa in [1, 1000): `999.9996` at three
places is `1.000e+3` (it used to print `1000.000e+0`), and the smallest
subnormals format as `5.000e-324`.

> **`notation: 'auto'` is not a drop-in for a fixed-unit readout.** The auto
> branch escapes to exponential once `abs(value) >= 1e21` or
> `abs(value) < 1e-6`, so `formatNumber(v, { precision: 3 })` is *not*
> interchangeable with `Float64.roundToPrecision(v, 3)`. A caller that
> appends its own unit — `"0.0509 ms"` — wants the value never to become
> `5.09e-5`, and must either pass `notation: 'fixed'` or round to
> significant figures itself. The website's timing helpers and the chart
> tick labels take the second route, via `roundToPrecision`.
