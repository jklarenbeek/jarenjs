//@ts-check
/**
 * The complete view stylesheet: one JSLT envelope assembling the shell
 * (unnamed mode), the page modes, the generic 'ui' render-node rules,
 * and the standard forms stylesheet from @jarenjs/app in mode 'form'.
 */

import { createFormView } from '@jarenjs/app';

import { SHELL_RULES } from './shell.js';
import { HOME_RULES } from './home.js';
import { BENCH_RULES } from './benchmarks.js';
import { CHARTSPAGE_RULES } from './chartspage.js';
import { PLAYGROUND_RULES } from './playground.js';
import { STATIC_RULES } from './staticpages.js';
import { README_RULES } from './readme.js';
import { UI_RULES } from './ui.js';
import { calcViewRules } from '@jarenjs/calc/component';

export const STYLESHEET = {
  $jslt: '0.1',
  // every mode fails LOUDLY on an unmatched node — a dispatch miss is
  // a bug, not content
  modes: {
    home: { unmatched: 'error' },
    playground: { unmatched: 'error' },
    benchmarks: { unmatched: 'error' },
    charts: { unmatched: 'error' },
    docs: { unmatched: 'error' },
    examples: { unmatched: 'error' },
    calculator: { unmatched: 'error' },
    readme: { unmatched: 'error' },
    ui: { unmatched: 'error' },
    form: { unmatched: 'error' },
  },
  rules: [
    ...SHELL_RULES,
    ...HOME_RULES,
    ...BENCH_RULES,
    ...CHARTSPAGE_RULES,
    ...PLAYGROUND_RULES,
    ...STATIC_RULES,
    ...README_RULES,
    ...UI_RULES,
    ...calcViewRules,
    ...createFormView({ root: '$.ui.pg.validate.form' }).map((rule) => ({ ...rule, mode: 'form' })),
  ],
};
