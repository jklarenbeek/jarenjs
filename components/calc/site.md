---
package: "@jarenjs/calc"
card:
  title: Calculator
  blurb: >-
    A multi-mode calculator (standard / scientific / programmer / financial
    / converter) as an @jarenjs/app document: a two-stage expression
    compiler (parseExpression ⇄ toExpression), x·y/x·y·z plots as pure-vnode
    SVG, and a pure numeric kernel pushed down into @jarenjs/core
    (math/finance/convert).
  perf: >-
    apps as JSON, eval-free, SSR-able
engines:
  - key: calc
---

A multi-mode calculator (standard/scientific/programmer/financial/converter) as
an `@jarenjs/app` document, with x·y and x·y·z plots rendered as pure-vnode
SVG. Its numeric kernel lives in `@jarenjs/core`: math (transcendentals, BigInt
word math, root finders, a mat4/projection 3D kernel, number formatting),
finance (TVM, NPV/IRR, amortization, bonds, indicators) and convert
(fixed-factor units + the pure convertCurrency rate-table primitive). The
expression engine is a two-stage compiler with a round-trip printer.

```js
import { evaluate, parseExpression, toExpression, plot2d, toSvgString } from '@jarenjs/calc';
evaluate('sin(pi/2) + 2^10').value;          // 1025
toExpression(parseExpression('a-(b-c)'));    // 'a - (b - c)'
toSvgString(plot2d('sin(x)', { domain: [-6.28, 6.28] }));
```

The converter’s currency dimension is the maturity example: live crypto+fiat
rates flow through an `@jarenjs/app` effect and a when-gated poll
(CoinGecko/Binance), while the pure conversion stays in
`@jarenjs/core/convert`. A static fallback keeps it working offline.

**Try it.** [Open the Calculator](#/calculator), switch modes, and plot an
expression — the whole page is an app document driving the same kernel.
