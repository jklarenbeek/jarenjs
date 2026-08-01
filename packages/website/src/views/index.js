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
import { STUDIO_RULES } from './studio.js';
import { FLOW_RULES } from './flowstudio.js';
import { GAME_RULES } from './game.js';
import { STATIC_RULES } from './staticpages.js';
import { README_RULES } from './readme.js';
import { ASSISTANT_RULES } from './assistant.js';
import { UI_RULES } from './ui.js';
import { calcViewRules } from '@jarenjs/calc/component';

export const STYLESHEET = {
  $jslt: '0.1',
  // every mode fails LOUDLY on an unmatched node — a dispatch miss is
  // a bug, not content
  modes: {
    home: { unmatched: 'error' },
    playground: { unmatched: 'error' },
    studio: { unmatched: 'error' },
    flow: { unmatched: 'error' },
    game: { unmatched: 'error' },
    benchmarks: { unmatched: 'error' },
    charts: { unmatched: 'error' },
    docs: { unmatched: 'error' },
    examples: { unmatched: 'error' },
    calculator: { unmatched: 'error' },
    readme: { unmatched: 'error' },
    assistant: { unmatched: 'error' },
    ui: { unmatched: 'error' },
    form: { unmatched: 'error' },
  },
  rules: [
    ...SHELL_RULES,
    ...HOME_RULES,
    ...BENCH_RULES,
    ...CHARTSPAGE_RULES,
    ...PLAYGROUND_RULES,
    ...STUDIO_RULES,
    ...FLOW_RULES,
    ...GAME_RULES,
    ...STATIC_RULES,
    ...README_RULES,
    ...ASSISTANT_RULES,
    ...UI_RULES,
    ...calcViewRules,
    ...createFormView({ root: '$.ui.pg.validate.form' }).map((rule) => ({ ...rule, mode: 'form' })),
    // the Flow inspector: the same generated form stylesheet, scoped to
    // the selection subtree and writing through the flow/f-* actions
    // (their target prepends the selection's pointer)
    ...createFormView({
      root: '$.ui.flow.live.inspector.form',
      actions: {
        input: 'flow/f-input', check: 'flow/f-check', number: 'flow/f-number',
        json: 'flow/f-json', add: 'flow/f-add', remove: 'flow/f-remove',
      },
    }).map((rule) => ({ ...rule, mode: 'flow' })),
  ],
};
