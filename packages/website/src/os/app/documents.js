//@ts-check
/**
 * The OS's own documents, catalogued for the Source app: every JSON
 * value the OS runs, by the name a person would look for it under. The
 * program is read from the live state — it is the one document the
 * council rewrites while you watch — the rest are the documents the OS
 * was built from, exactly as compiled.
 */

import contract from '../documents/os.contract.json' with { type: 'json' };
import workflow from '../documents/council.workflow.json' with { type: 'json' };
import merit from '../documents/merit.dag.json' with { type: 'json' };
import art from '../documents/art.dag.json' with { type: 'json' };
import sculpt from '../documents/sculpt.jslt.json' with { type: 'json' };
import scene from '../documents/scene.jslt.json' with { type: 'json' };
import theme from '../documents/theme.css.jtlt.json' with { type: 'json' };
import artwork from '../documents/artwork.html.jtlt.json' with { type: 'json' };
import machineModule from '../documents/machine.js.jtlt.json' with { type: 'json' };
import model from '../documents/os.model.json' with { type: 'json' };
import storeContract from '../documents/store.contract.json' with { type: 'json' };
import { ACTIONS } from './actions.js';
import { VIEW } from './view.js';

/**
 * @typedef {{ id: string, label: string, about: string, format: string, read: (state: any) => any, path?: (state: any) => string[] }} OsDocument
 */

/** @type {readonly OsDocument[]} */
export const DOCUMENTS = Object.freeze([
  {
    id: 'machine', label: 'The machine', format: 'jaren-fsm 0.1',
    about: 'The Turing machine’s finite control. Transition q·6+s is the rule for state q reading symbol s; its two effects say what to write and how to turn. The council amends this document — it is the program you are watching.',
    read: (state) => state.program.machine,
    // the transitions the heads fired on the last step light up
    path: (state) => (state.machine.fired ?? []).map((/** @type {number} */ i) => `$['transitions'][${i}]`),
  },
  {
    id: 'council', label: 'The council', format: 'jaren-workflow 0.2',
    about: 'One session: a DAG gathers proposals, judges them by simulation and tallies the votes by merit; the verdict state waits for your veto, your approval or its timer.',
    read: () => workflow,
    path: (state) => [`$['states']['${({ idle: 'adjourn', convening: 'convene', veto: 'verdict', enacting: 'enact' })[/** @type {'idle'} */ (state.council.phase)] ?? 'adjourn'}']`],
  },
  {
    id: 'merit', label: 'Merit', format: 'jaren-dag 0.1',
    about: 'How merit is earned: the proposer gains by the harmony its amendment measurably added and by how many tastes it lifted together; voters gain for backing improvements. A veto costs the proposer and its backers a little — the council learns your taste.',
    read: () => merit,
  },
  {
    id: 'contract', label: 'System calls', format: '$contract 0.1',
    about: 'Every operation the OS answers, for you, for its members and for language models alike. The veto, the early approval and the repeal are yours alone: they are kept out of every tool projection.',
    read: () => contract,
  },
  {
    id: 'actions', label: 'Actions', format: 'jaren-app actions',
    about: 'Every state change the chrome can make, as query documents. JavaScript enters only at the effects they name.',
    read: () => ACTIONS,
  },
  {
    id: 'view', label: 'The view', format: 'JSLT 0.1',
    about: 'The stylesheet that turns the OS state into the interface you are using: JSONPath matches, query bodies, vnodes out.',
    read: () => VIEW,
  },
  {
    id: 'scene', label: 'The scene', format: 'JSLT 0.1',
    about: 'The transformation from the OS state to the stage’s 3D scene: the tape, the dancers and the merits that size them.',
    read: () => scene,
  },
  {
    id: 'art', label: 'Art pipeline', format: 'jaren-dag 0.1',
    about: 'One run renders every text form of the artwork: query nodes shape each template’s input, render tasks run the JTLT templates.',
    read: () => art,
  },
  {
    id: 'theme', label: 'Theme template', format: 'JTLT 0.1 → CSS',
    about: 'The stylesheet the OS wears, as a template. It is re-rendered when the council’s leader changes, and the chrome takes the leader’s colour.',
    read: () => theme,
  },
  {
    id: 'artwork', label: 'Artwork template', format: 'JTLT 0.1 → HTML',
    about: 'The still frame as a standalone page: the SVG embedded raw, every interpolated value escaped by the xml method.',
    read: () => artwork,
  },
  {
    id: 'module', label: 'Machine template', format: 'JTLT 0.1 → JavaScript',
    about: 'The program as a module that runs without the OS — and reproduces this machine step for step.',
    read: () => machineModule,
  },
  {
    id: 'sculpt', label: 'The sculptor', format: 'JSLT 0.1',
    about: 'Any JSON value as a crowd of figures: objects hold their members up, arrays hold hands, strings speak, numbers radiate, booleans are hearts. It sculpts every document in this list — itself included.',
    read: () => sculpt,
  },
  {
    id: 'model', label: 'Storage model', format: '$model 0.1',
    about: 'The OS’s own database: kept artworks, the constitution and the running session, in SQLite through @jarenjs/db.',
    read: () => model,
  },
  {
    id: 'store', label: 'Storage calls', format: '$contract 0.1',
    about: 'The operations the database worker serves across its port.',
    read: () => storeContract,
  },
]);
