//@ts-check
/**
 * @file The `calculator` JSLT view. Rules render the
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

      // the keypad region (standard / scientific / programmer): it takes
      // focus, and the keyboard types into it (`bindCalcKeyboard`)
      { $if: ['$.hasKeypad', ['div', { class: 'calc-pad', tabindex: '0' },
        ['output', { class: 'calc-display', 'aria-live': 'polite', 'aria-label': '$.displayLabel' },
          ['span', { class: 'calc-entry' }, '$.display.entry'],
          ['span', { class: 'calc-result' }, '$.display.result'],
          { $if: ['$.display.error', ['span', { class: 'calc-err' }, '$.display.error']] },
        ],

        // programmer four-base view + word size toggles + what the words do
        { $if: ['$.isProgrammer', ['div', { class: 'calc-bases' },
          ['div', { class: 'calc-baserow' }, ['span', { class: 'calc-baselabel' }, 'HEX'], ['span', { class: 'calc-baseval' }, '$.bases.views.hex']],
          ['div', { class: 'calc-baserow' }, ['span', { class: 'calc-baselabel' }, 'DEC'], ['span', { class: 'calc-baseval' }, '$.bases.views.dec']],
          ['div', { class: 'calc-baserow' }, ['span', { class: 'calc-baselabel' }, 'OCT'], ['span', { class: 'calc-baseval' }, '$.bases.views.oct']],
          ['div', { class: 'calc-baserow' }, ['span', { class: 'calc-baselabel' }, 'BIN'], ['span', { class: 'calc-baseval' }, '$.bases.views.bin']],
          ['div', { class: 'calc-wordopts' }, [{ $apply: '$.bases.wordOptions[*]' }]],
          ['p', { class: 'calc-note' }, '$.bases.shiftNote'],
          ['p', { class: 'calc-note' }, '$.bases.note'],
        ]] },

        // scientific angle mode toggle
        { $if: ['$.isScientific', ['div', { class: 'calc-angle' }, [{ $apply: '$.angle.options[*]' }]]] },

        ['div', { class: 'calc-keypad' }, [{ $apply: '$.keypad[*]' }]],

        ['div', { class: 'calc-mem' },
          ['button', { type: 'button', class: 'calc-key calc-key-mem', 'aria-label': '$.memoryLabels.add', title: '$.memoryLabels.add', on: { click: { action: 'calc/mem-add' } } }, 'M+'],
          ['button', { type: 'button', class: 'calc-key calc-key-mem', 'aria-label': '$.memoryLabels.clear', title: '$.memoryLabels.clear', on: { click: { action: 'calc/mem-clear' } } }, 'MC'],
          ['span', { class: 'calc-memval' }, 'M = ', '$.memory'],
        ],
        ['p', { class: 'calc-note calc-kbd-hint' }, '$.keyboardHint'],
      ]] },

      // financial panel: what it is, the form (from @jarenjs/forms), the
      // answer and why it has its sign, and worked examples
      { $if: ['$.financial', ['div', { class: 'calc-financial' },
        ['div', { class: 'calc-fin-help' }, [{ $apply: '$.financial.help[*]' }]],
        ['div', { class: 'calc-fin-form' }, { $apply: '$.financial.form' }],
        ['div', { class: 'calc-fin-result', 'aria-live': 'polite' }, ['span', {}, '$.financial.resultLabel'], ['strong', {}, '$.financial.result']],
        { $if: ['$.financial.noSolution', ['p', { class: 'calc-fin-nosolution' }, '$.financial.noSolution']] },
        ['div', { class: 'calc-fin-help' }, [{ $apply: '$.financial.notes[*]' }]],
        ['div', { class: 'calc-fin-examples' },
          ['p', { class: 'calc-fin-examples-label' }, '$.financial.examplesLabel'],
          ['ul', {}, [{ $apply: '$.financial.examples[*]' }]],
        ],
      ]] },

      // converter panel: every conversion via @jarenjs/core/convert
      { $if: ['$.converter', ['div', { class: 'calc-converter' },
        ['label', { class: 'calc-conv-dimlabel' }, '$.converter.dimensionLabel',
          ['select', { class: 'calc-dim', on: { change: { action: 'calc/conv-dim' } } }, [{ $apply: '$.converter.dimensions[*]' }]],
        ],
        ['div', { class: 'calc-conv-row' },
          ['input', { type: 'text', class: 'calc-conv-input', inputmode: 'decimal', 'aria-label': '$.converter.valueLabel', value: '$.converter.value', on: { input: { action: 'calc/conv-value' } } }],
          ['select', { class: 'calc-conv-from', 'aria-label': '$.converter.fromLabel', on: { change: { action: 'calc/conv-from' } } }, [{ $apply: '$.converter.unitsFrom[*]' }]],
          ['button', { type: 'button', class: 'calc-swap', 'aria-label': '$.converter.swapLabel', title: '$.converter.swapLabel', on: { click: { action: 'calc/conv-swap' } } }, '⇄'],
          ['select', { class: 'calc-conv-to', 'aria-label': '$.converter.toLabel', on: { change: { action: 'calc/conv-to' } } }, [{ $apply: '$.converter.unitsTo[*]' }]],
        ],
        ['div', { class: 'calc-conv-result', 'aria-live': 'polite' }, ['strong', {}, '$.converter.result']],
        { $if: ['$.converter.isCurrency', ['div', { class: 'calc-rates', 'aria-live': 'polite' },
          ['span', {}, '$.converter.rates.statusLabel'],
          ['button', { type: 'button', class: 'calc-rates-refresh', 'aria-label': '$.converter.rates.refreshLabel', title: '$.converter.rates.refreshLabel', on: { click: { action: 'calc/rates-refresh' } } }, '↻'],
        ]] },
      ]] },

      // plot panel (scientific)
      { $if: ['$.plot', ['div', { class: 'calc-plot-panel' },
        ['div', { class: 'calc-plot-kinds' }, [{ $apply: '$.plot.kinds[*]' }]],
        ['input', { type: 'text', class: 'calc-plot-expr', 'aria-label': '$.plot.exprLabel', value: '$.plot.expr', on: { input: { action: 'calc/plot-expr' } } }],
        ['div', { class: 'calc-plot-svg' }, '$.plot.svg'],
      ]] },

      // history tape (the keypad modes)
      { $if: ['$.tape', ['div', { class: 'calc-tape' }, [{ $apply: '$.tape[*]' }]]] },
    ],
  },

  { match: '$.ui.calculator.modes[*]', mode: 'calculator',
    body: ['button', { type: 'button', class: { $if: ['$.active', 'calc-mode calc-mode-active', 'calc-mode'] }, on: '$.on' }, '$.label'] },

  { match: '$.ui.calculator.keypad[*]', mode: 'calculator',
    body: ['div', { class: 'calc-row' }, [{ $apply: '$.keys[*]' }]] },

  { match: '$.ui.calculator.keypad[*].keys[*]', mode: 'calculator',
    body: ['button', { type: 'button', class: '$.cls', 'aria-label': '$.aria', on: '$.on' }, '$.label'] },

  { match: '$.ui.calculator.financial.help[*]', mode: 'calculator',
    body: ['p', { class: 'calc-note' }, '$.text'] },

  { match: '$.ui.calculator.financial.notes[*]', mode: 'calculator',
    body: ['p', { class: 'calc-note' }, '$.text'] },

  { match: '$.ui.calculator.financial.examples[*]', mode: 'calculator',
    body: ['li', {},
      ['button', { type: 'button', class: 'calc-fin-example', on: '$.on' }, '$.label'],
      ['span', { class: 'calc-fin-example-text' }, '$.text'],
    ] },

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
