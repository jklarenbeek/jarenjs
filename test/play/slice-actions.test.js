//@ts-check
/**
 * @file `playSliceActions({ langPointer })` is the play slice's reducers as
 * app action documents — `play/loaded`, `play/option-set` and
 * `play/loaded-session` — writing the reader's language at the pointer the
 * host names: the website's own actions are these documents over `/lang`,
 * and a host keeping the language elsewhere gets them over its pointer.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { createApp } from '@jarenjs/app';
import { playSliceActions, PLAY_START, switchPlayOption, sessionToLoaded, sessionOf } from '@jarenjs/play/host';
import { ACTIONS } from '../../packages/website/src/app/actions.js';

const NAMES = ['play/loaded', 'play/option-set', 'play/loaded-session'];

/** A headless app over the slice and a language at `lang` (a pointer). @param {string} langPointer @param {any} state */
const appOver = (langPointer, state) => createApp({ state, actions: playSliceActions({ langPointer }), view: [{ match: '$', body: ['main', {}] }] },
  { schedule: (/** @type {() => void} */ f) => f() });

describe('playSliceActions', () => {
  it('are the website\'s play reducers over /lang, document for document', () => {
    const kit = playSliceActions({ langPointer: '/lang' });
    assert.deepEqual(Object.keys(kit), NAMES);
    for (const name of NAMES) assert.equal(JSON.stringify(ACTIONS[name]), JSON.stringify(kit[name]), name);
  });

  it('write the reader\'s language at the host\'s pointer, and only when the option chose one', async () => {
    const app = appOver('/reader/lang', { reader: { lang: 'en' }, play: structuredClone(PLAY_START) });
    const validate = { ...structuredClone(PLAY_START), engine: 'validate', config: { locale: 'en' } };
    app.dispatch('play/option-set', { ...switchPlayOption(validate, 'locale', 'nl'), lang: 'nl' });
    await app.settled();
    assert.equal(app.getState().reader.lang, 'nl');
    app.dispatch('play/option-set', { ...switchPlayOption(app.getState().play, 'locale', 'en'), lang: null });
    await app.settled();
    assert.equal(app.getState().reader.lang, 'nl', 'a null lang keeps the reader\'s');
    app.dispatch('play/loaded-session', { ...sessionToLoaded(sessionOf(app.getState().play)), name: 'mine' });
    await app.settled();
    assert.equal(app.getState().play.exampleLocale, null);
    assert.equal(app.getState().play.name, 'mine');
    assert.equal(app.getState().reader.lang, 'nl');
  });

  it('read the language back by the pointer\'s own path', () => {
    const lang = (/** @type {string} */ pointer) => playSliceActions({ langPointer: pointer })['play/option-set'].patch[7];
    assert.deepEqual(lang('/lang'), { op: 'replace', path: '/lang', value: { $if: ['$payload.lang', '$payload.lang', '$.lang'] } });
    assert.deepEqual(lang('/ui/reader_1/lang').value.$if[2], '$.ui.reader_1.lang');
    assert.deepEqual(lang('/a b/0').value.$if[2], "$['a b'][0]");
  });

  it('refuse a language pointer that names no member', () => {
    for (const bad of ['', undefined, 5]) {
      assert.throws(() => playSliceActions(/** @type {any} */ ({ langPointer: bad })),
        (/** @type {any} */ error) => error instanceof TypeError && /^playSliceActions: langPointer must be a JSON Pointer to a member, got /.test(error.message));
    }
    assert.throws(() => playSliceActions({ langPointer: 'lang' }));
  });
});
