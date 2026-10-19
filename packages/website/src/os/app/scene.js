//@ts-check
/**
 * The scene stylesheet (`scene.jslt.json`): the JSLT transformation from
 * the OS state to the stage's scene document — the tape, the heads and
 * the colours and merits of the members wearing them, the session the
 * signs are held up for. The view stylesheet embeds its rules in a mode
 * of their own and hands the result to the stage widget as props; the
 * exports compile it on its own to draw the still frame.
 */

import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import sceneDoc from '../documents/scene.jslt.json' with { type: 'json' };

/** The scene rules, moved into the `scene` mode for the view stylesheet. */
export const SCENE_RULES = Object.freeze(sceneDoc.rules.map((rule) => ({ ...rule, mode: 'scene' })));

const transform = compileJsltStylesheet(sceneDoc);

/**
 * The scene document for a state.
 * @param {any} state
 * @returns {import('../stage/scene.js').Scene}
 */
export function sceneOf(state) {
  return /** @type {any} */ (transform(state));
}

/** The scene stylesheet itself, for the Source app. */
export const SCENE_DOCUMENT = sceneDoc;
