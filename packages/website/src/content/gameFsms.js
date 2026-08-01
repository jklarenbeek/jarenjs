//@ts-check
/**
 * The game's state machines as jaren-fsm documents. The scene/transition FSM
 * is DERIVED from the location graph — states are rooms, events are exits —
 * so it is no-dead-ends by construction (every exit is bidirectional in the
 * content). `fsmToApp` bakes it into pure @jarenjs/app actions: navigation is
 * the flow engine, not hand-written JS.
 */
import { fsmToApp } from '@jarenjs/flow';
import { LOCATIONS, START_LOCATION } from './gameContent.js';

/** Build the scene/transition FSM from the location graph. */
export function buildSceneFsm() {
  const states = Object.keys(LOCATIONS);
  const transitions = [];
  for (const from of states) {
    for (const to of LOCATIONS[from].exits) {
      if (states.includes(to)) transitions.push({ from, event: `go-${to}`, to });
    }
  }
  return { initial: START_LOCATION, states, transitions };
}

/**
 * The scene FSM baked into app pieces: `slice` seeds state.game.room, and
 * `actions` are the namespaced navigation actions (scene/go-<room>).
 */
export function sceneApp() {
  return fsmToApp(buildSceneFsm(), { pointer: '/game/room', namespace: 'scene/' });
}
