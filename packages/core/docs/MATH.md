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
`roundTo(value, digits)`, `nthroot(x, n)` (odd roots of negatives),
`sign(x)`, `logBase(base, x)`, `cosHp(r)` (a high-precision
polynomial cosine).

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
`wAnd/wOr/wXor/wNot/wShl/wShr/wRol/wRor/wMod` operate at a width;
`toBase(int, radix, {group, sep, pad, upper})` and `fromBase(str, radix)`
(prefix-aware: `0x`/`0o`/`0b`) are the radix string I/O.

## Root finders — `solve.js`

Domain-free `newtonRaphson(f, df, x0, opts)`, `bisect(f, a, b, opts)`,
`secant(f, x0, x1, opts)`. Each returns `{ root, iterations, converged }`
and never throws on non-convergence. `@jarenjs/core/finance` builds
`irr`/`rate` on top.

## 3D kernel — `mat4.js` + `project.js`

`Mat4` (column-major `Float64Array(16)`): `identity`, `multiply`,
`rotationX/Y/Z`, `translation`, `scaling`, `ortho`, `perspective`,
`transformPoint`. `project3dTo2d(point3, mat, viewport)` maps a point to
SVG pixels (Y flipped); `surfaceNormal(a, b, c)` returns the face normal
as a `Vec3f64`. Reusable for any 3D projection (the x·y·z plotter is the
first consumer; Mermaid 3D is a candidate — see ROADMAP).

## Number formatting — `format.js`

`formatNumber(value, { notation:'auto'|'fixed'|'sci'|'eng', precision,
group, radix, decimal })` and radix-aware `parseNumber(str, { radix })`
(recognizes `0x`/`0o`/`0b` prefixes, grouping separators and scientific
notation; returns `NaN` on failure). Radix I/O delegates to `word.js`.

> **`notation: 'auto'` is not a drop-in for a fixed-unit readout.** The auto
> branch escapes to exponential once `abs(value) >= 1e21` or
> `abs(value) < 1e-6`, so `formatNumber(v, { precision: 3 })` is *not*
> interchangeable with a plain `Number(v.toPrecision(3))`. A caller that
> appends its own unit — `"0.0509 ms"` — wants the value never to become
> `5.09e-5`, and must either pass `notation: 'fixed'` or keep its own
> rounder. The website's timing helpers keep their own for exactly this
> reason.
