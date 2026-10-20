//@ts-check
/**
 * What the arcade's chrome shows for Tape Dancers: the level and its
 * tier, the goal in words, the stars and steps, the buttons, a meter of
 * steps against par — and the rule table itself as the HUD grid, the
 * editor a person plays with: one row per control state, and for each
 * ink the dancer may read three cells, the ink it writes (with its
 * swatch), the step it takes and the state it goes to. A press on a cell
 * cycles that member (`{ type: 'cell', id: 'q0:1:write' }`), and the
 * three cells of the rule that just fired light up.
 */

import { INKS, INK_NAMES } from './program.js';
import { LEVELS, plural, starText, tierOf } from './levels.js';
import { levelOf, rulesOf } from './state.js';

/**
 * @typedef {import('./state.js').DancersState} DancersState
 * @typedef {import('./state.js').Run} Run
 * @typedef {import('./levels.js').Level} Level
 * @typedef {import('./program.js').RuleTable} RuleTable
 * @typedef {import('../game.js').Hud} Hud
 * @typedef {NonNullable<Hud['grid']>} Grid
 */

/**
 * The rule table as the HUD grid.
 * @param {Level} level @param {RuleTable} rules @param {Run['fired']} fired
 * @returns {Grid}
 */
export function ruleGrid(level, rules, fired) {
  const inks = INK_NAMES.slice(0, level.symbols);
  return {
    columns: inks.flatMap((name) => [`${name} ink`, `${name} step`, `${name} next`]),
    rows: Object.entries(rules).map(([state, row], q) => ({
      label: q === 0 ? `${state} · start` : state,
      cells: row.flatMap((rule, symbol) => {
        const active = fired?.state === state && fired.symbol === symbol;
        return [
          { id: `${state}:${symbol}:write`, text: INK_NAMES[rule.write], swatch: INKS[rule.write], active },
          { id: `${state}:${symbol}:move`, text: rule.move, active },
          { id: `${state}:${symbol}:next`, text: rule.next, active },
        ];
      }),
    })),
  };
}

/**
 * The chrome for a state.
 * @param {DancersState} state @returns {Hud}
 */
export function hud(state) {
  const level = levelOf(state);
  const tier = tierOf(level);
  const rules = rulesOf(state);
  const states = Object.keys(rules);
  const { run, verdict } = state;
  const best = state.progress[level.id];
  const solved = verdict?.solved === true;
  const used = run.total + run.steps;
  const { par } = level;
  const score = solved && verdict ? `${starText(verdict.stars)} · ${plural(verdict.steps, 'step')}`
    : best ? `Best ${starText(best.stars)} · ${plural(best.steps, 'step')}`
      : `${starText(0)} · par ${plural(par.steps, 'step')}`;
  return {
    title: `${level.name} · ${tier.name}`,
    subtitle: tier.blurb,
    prompt: `${level.prompt} (${plural(level.tests.length, 'tape')})`,
    level: `Level ${LEVELS.indexOf(level) + 1} · ${tier.name}`,
    score,
    buttons: [
      { id: 'run', label: run.mode === 'running' ? 'Pause' : run.mode === 'done' ? 'Run again' : 'Run', primary: !solved },
      { id: 'step', label: 'Step' },
      { id: 'reset', label: 'Reset' },
      { id: 'hint', label: 'Hint' },
      { id: 'addState', label: 'Add state' },
      ...(states.length > 1 ? [{ id: 'removeState', label: `Remove ${states[states.length - 1]}` }] : []),
      { id: 'next', label: 'Next level', primary: solved },
    ],
    meter: { label: `Steps ${used} / par ${par.steps}`, value: Math.min(1, used / par.steps) },
    toast: verdict ? verdict.text : null,
    help: `Tap a rule cell to cycle its ink, its step (L, R or S to stay) or its next state. ★ solve every tape · `
      + `★★ with ${plural(par.states, 'state')} or fewer · ★★★ also in ${plural(par.steps, 'step')} or fewer.`,
    grid: ruleGrid(level, rules, run.fired),
  };
}
