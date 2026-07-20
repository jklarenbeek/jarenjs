//@ts-check
/**
 * @file The `calculator` JSLT view (design decision D10). Rules render the
 * viewModel document produced by `contributeCalcViewModel`. Convention
 * (mirrors the website views): `match` patterns are absolute from the
 * document root; `$apply` paths and body `$` are relative to the matched
 * node; list children wrap `[{ $apply: '…[*]' }]`; a ready-made vnode
 * (the plot SVG, `$.plot.svg`) splices in verbatim as a query-string
 * child.
 *
 * Mounted by the host with `{ $apply: ['$.ui.calculator', 'calculator'] }`.
 */

export const CALCULATOR_RULES = [
  {
    match: '$.ui.calculator', mode: 'calculator',
    body: ['div', { class: 'calc' },
      ['div', { class: 'calc-modes' }, [{ $apply: '$.modes[*]' }]],

      ['div', { class: 'calc-display' },
        ['div', { class: 'calc-entry' }, '$.display.entry'],
        ['div', { class: 'calc-result' }, '$.display.result'],
        { $if: ['$.display.error', ['div', { class: 'calc-err' }, '$.display.error']] },
      ],

      // programmer four-base view + word size toggles
      { $if: ['$.isProgrammer', ['div', { class: 'calc-bases' },
        ['div', { class: 'calc-baserow' }, ['span', { class: 'calc-baselabel' }, 'HEX'], ['span', { class: 'calc-baseval' }, '$.bases.views.hex']],
        ['div', { class: 'calc-baserow' }, ['span', { class: 'calc-baselabel' }, 'DEC'], ['span', { class: 'calc-baseval' }, '$.bases.views.dec']],
        ['div', { class: 'calc-baserow' }, ['span', { class: 'calc-baselabel' }, 'OCT'], ['span', { class: 'calc-baseval' }, '$.bases.views.oct']],
        ['div', { class: 'calc-baserow' }, ['span', { class: 'calc-baselabel' }, 'BIN'], ['span', { class: 'calc-baseval' }, '$.bases.views.bin']],
        ['div', { class: 'calc-wordopts' }, [{ $apply: '$.bases.wordOptions[*]' }]],
      ]] },

      // scientific angle mode toggle
      { $if: ['$.isScientific', ['div', { class: 'calc-angle' }, [{ $apply: '$.angle.options[*]' }]]] },

      // keypad (standard / scientific / programmer)
      { $if: ['$.keypad', ['div', { class: 'calc-keypad' }, [{ $apply: '$.keypad[*]' }]]] },

      // memory row (present for calculator-style modes)
      { $if: ['$.keypad', ['div', { class: 'calc-mem' },
        ['button', { type: 'button', class: 'calc-key calc-key-mem', on: { click: { action: 'calc/mem-add' } } }, 'M+'],
        ['button', { type: 'button', class: 'calc-key calc-key-mem', on: { click: { action: 'calc/mem-clear' } } }, 'MC'],
        ['span', { class: 'calc-memval' }, 'M = ', '$.memory'],
      ]] },

      // financial panel — the form comes from @jarenjs/forms
      { $if: ['$.financial', ['div', { class: 'calc-financial' },
        ['div', { class: 'calc-fin-form' }, { $apply: '$.financial.form' }],
        ['div', { class: 'calc-fin-result' }, ['span', {}, 'Result ('], ['span', {}, '$.financial.solveFor'], ['span', {}, '): '], ['strong', {}, '$.financial.result']],
      ]] },

      // converter panel — every conversion via @jarenjs/core/convert
      { $if: ['$.converter', ['div', { class: 'calc-converter' },
        ['label', { class: 'calc-conv-dimlabel' }, 'Dimension ',
          ['select', { class: 'calc-dim', on: { change: { action: 'calc/conv-dim' } } }, [{ $apply: '$.converter.dimensions[*]' }]],
        ],
        ['div', { class: 'calc-conv-row' },
          ['input', { type: 'text', class: 'calc-conv-input', value: '$.converter.value', on: { input: { action: 'calc/conv-value' } } }],
          ['select', { class: 'calc-conv-from', on: { change: { action: 'calc/conv-from' } } }, [{ $apply: '$.converter.unitsFrom[*]' }]],
          ['button', { type: 'button', class: 'calc-swap', on: { click: { action: 'calc/conv-swap' } } }, '⇄'],
          ['select', { class: 'calc-conv-to', on: { change: { action: 'calc/conv-to' } } }, [{ $apply: '$.converter.unitsTo[*]' }]],
        ],
        ['div', { class: 'calc-conv-result' }, ['strong', {}, '$.converter.result']],
        { $if: ['$.converter.isCurrency', ['div', { class: 'calc-rates' },
          ['span', {}, 'rates: '], ['span', {}, '$.converter.rates.status'],
          { $if: ['$.converter.rates.stale', ['span', { class: 'calc-rates-stale' }, ' · static fallback']] },
          ['button', { type: 'button', class: 'calc-rates-refresh', on: { click: { action: 'calc/rates-refresh' } } }, '↻'],
        ]] },
      ]] },

      // plot panel (standard / scientific)
      { $if: ['$.plot', ['div', { class: 'calc-plot-panel' },
        ['div', { class: 'calc-plot-kinds' }, [{ $apply: '$.plot.kinds[*]' }]],
        ['input', { type: 'text', class: 'calc-plot-expr', value: '$.plot.expr', on: { input: { action: 'calc/plot-expr' } } }],
        ['div', { class: 'calc-plot-svg' }, '$.plot.svg'],
      ]] },

      // history tape
      { $if: ['$.tape', ['div', { class: 'calc-tape' }, [{ $apply: '$.tape[*]' }]]] },
    ],
  },

  { match: '$.ui.calculator.modes[*]', mode: 'calculator',
    body: ['button', { type: 'button', class: { $if: ['$.active', 'calc-mode calc-mode-active', 'calc-mode'] }, on: '$.on' }, '$.label'] },

  { match: '$.ui.calculator.keypad[*]', mode: 'calculator',
    body: ['div', { class: 'calc-row' }, [{ $apply: '$.keys[*]' }]] },

  { match: '$.ui.calculator.keypad[*].keys[*]', mode: 'calculator',
    body: ['button', { type: 'button', class: '$.cls', on: '$.on' }, '$.label'] },

  { match: '$.ui.calculator.angle.options[*]', mode: 'calculator',
    body: ['button', { type: 'button', class: { $if: ['$.active', 'calc-angle-btn active', 'calc-angle-btn'] }, on: '$.on' }, '$.label'] },

  { match: '$.ui.calculator.bases.wordOptions[*]', mode: 'calculator',
    body: ['button', { type: 'button', class: { $if: ['$.active', 'calc-word active', 'calc-word'] }, on: '$.on' }, '$.label'] },

  { match: '$.ui.calculator.plot.kinds[*]', mode: 'calculator',
    body: ['button', { type: 'button', class: { $if: ['$.active', 'calc-plotkind active', 'calc-plotkind'] }, on: '$.on' }, '$.label'] },

  { match: '$.ui.calculator.converter.dimensions[*]', mode: 'calculator',
    body: ['option', { value: '$.id', selected: '$.selected' }, '$.label'] },

  { match: '$.ui.calculator.converter.unitsFrom[*]', mode: 'calculator',
    body: ['option', { value: '$.id', selected: '$.selected' }, '$.symbol'] },

  { match: '$.ui.calculator.converter.unitsTo[*]', mode: 'calculator',
    body: ['option', { value: '$.id', selected: '$.selected' }, '$.symbol'] },

  { match: '$.ui.calculator.tape[*]', mode: 'calculator',
    body: ['div', { class: 'calc-tape-row' },
      ['span', { class: 'calc-tape-expr' }, '$.expr'],
      ['span', { class: 'calc-tape-eq' }, ' = '],
      ['span', { class: 'calc-tape-res' }, '$.result'],
    ] },
];
