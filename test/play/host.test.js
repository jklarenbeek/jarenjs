//@ts-check
/**
 * @file A third-party Play host, composed from `@jarenjs/play/host` alone:
 * no website module, no copied boundary. It validates with referenced
 * schemas, localizes the report to two languages loaded through its own
 * `import()`s, keeps the text a schema wrote, switches an option, renders
 * the generated form's chrome in the reader's language, and keeps the
 * reader's language out of what it saves.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { createPlayComponent } from '@jarenjs/play/component';
import {
  PLAY_LOCALES, PLAY_START, isPlayLocale,
  createPlayCatalogs, createPackRequester, createPlayValidator, localizePlayErrors,
  detectDraftName, referencedSchemas,
  runPlay, withPlayLocale, switchPlayOption, loadExample, loadDataset, deepLinkExample,
  sessionOf, sessionToLoaded, sessionDocument, sessionFromDocument, sessionFilename, blankSession,
  playFormActions, playDataForm, PLAY_FORM_VIEW,
} from '@jarenjs/play/host';
import { LOCALE_NAMES } from '@jarenjs/locales/names';
import { localizeErrors } from '@jarenjs/validate';
import { stringFormats, numberFormats, dateTimeFormats, jsonFormats } from '@jarenjs/formats';
import { buildFormModel, buildFormViewModel, formChromeLabels } from '@jarenjs/forms';
import { FORM_NUMBER_VALUE, createFormView } from '@jarenjs/app';

/** The host's own loaders: the kit names no pack and imports none. */
const LOADERS = /** @type {Record<string, () => Promise<Record<string, any>>>} */ ({
  de: () => import('@jarenjs/locales/de').then((m) => m.de),
  fr: () => import('@jarenjs/locales/fr').then((m) => m.fr),
});
/** @param {string} code */
const load = async (code) => (Object.hasOwn(LOADERS, code) ? LOADERS[code]() : null);

/** A host: one catalog set, one validator over it, the component with the seam. */
function createHost() {
  const catalogs = createPlayCatalogs();
  const validator = createPlayValidator({
    catalogs,
    formats: [stringFormats, numberFormats, dateTimeFormats, jsonFormats],
    forms: { buildFormModel, buildFormViewModel, formChromeLabels },
  });
  const component = createPlayComponent({ validate: validator.validate });
  return { catalogs, validator, component };
}

const ADDRESS = { $id: 'https://example.test/address', type: 'object', required: ['city'], properties: { city: { type: 'string' } } };
const PERSON = JSON.stringify({
  type: 'object', required: ['name', 'address'],
  properties: {
    name: { type: 'string' },
    age: { type: 'integer', errorMessage: 'age must be a whole number' },
    address: { $ref: 'https://example.test/address' },
  },
});

describe('@jarenjs/play/host — a headless host composes the kit', () => {
  it('lists the languages: English first, then every locale pack', () => {
    assert.deepStrictEqual(PLAY_LOCALES, ['en', ...LOCALE_NAMES.map(({ code }) => code)]);
    assert.strictEqual(isPlayLocale('de'), true);
    assert.strictEqual(isPlayLocale('xx'), false);
    assert.strictEqual(isPlayLocale('constructor'), false);
  });

  it('validates against a referenced schema and reports the draft', () => {
    const { validator } = createHost();
    const report = validator.run(PERSON, { name: 'Ada', address: {} }, [ADDRESS]);
    assert.strictEqual(report.schemaError, null);
    assert.strictEqual(report.valid, false);
    assert.deepStrictEqual(report.errors.map((e) => [e.instancePath, e.keyword]), [['/address', 'required']]);
    assert.strictEqual(report.draft, 'draft-07 (default)');
    assert.strictEqual(detectDraftName({ $schema: 'https://json-schema.org/draft/2020-12/schema' }), '2020-12');
    assert.deepStrictEqual(referencedSchemas(JSON.stringify([ADDRESS, { type: 'string' }, null])), [ADDRESS]);
    assert.deepStrictEqual(referencedSchemas('not json'), []);
  });

  it('a broken referenced schema is located at the schemas pane', () => {
    const { validator } = createHost();
    const report = validator.run('{"type":"object"}', {}, [{ $id: 'https://example.test/bad', type: 7 }]);
    assert.strictEqual(report.schemaPane, 'schemas');
    assert.match(report.schemaError, /^schemas\[0\] \(https:\/\/example\.test\/bad\): /);
  });

  it('a schema that is not JSON keeps the parser\'s reason for the host\'s own words', () => {
    const { validator } = createHost();
    const report = validator.run('{', {}, []);
    assert.strictEqual(report.valid, null);
    assert.strictEqual(typeof report.schemaJsonReason, 'string');
    assert.strictEqual(report.schemaError, `Invalid JSON: ${report.schemaJsonReason}`);
  });

  it('loads two languages through the host\'s loader and localizes the same report to each, inline text kept', async () => {
    const { catalogs, validator } = createHost();
    /** @type {string[]} */
    const landed = [];
    const requester = createPackRequester({ catalogs, load, onLoaded: (code) => landed.push(code) });
    assert.strictEqual(catalogs.catalogFor('de'), undefined, 'nothing loads until asked');
    await requester.request(['de', 'fr', 'en', null, 'xx']);
    assert.deepStrictEqual(landed.sort(), ['de', 'fr']);
    const data = { name: 7, age: 1.5, address: { city: 'Delft' } };
    const english = validator.validate(PERSON, data, 'en', [ADDRESS]);
    const german = validator.validate(PERSON, data, 'de', [ADDRESS]);
    const french = validator.validate(PERSON, data, 'fr', [ADDRESS]);
    const byPath = (/** @type {any} */ r) => Object.fromEntries(r.errors.map((/** @type {any} */ e) => [e.instancePath, e.message]));
    for (const report of [english, german, french]) assert.strictEqual(byPath(report)['/age'], 'age must be a whole number', 'the schema\'s words stay as written');
    const raw = validator.run(PERSON, data, [ADDRESS]).errors;
    const expected = (/** @type {string} */ code) => localizeErrors(raw.map((e) => ({ ...e })), catalogs.catalogFor(code))
      .find((/** @type {any} */ e) => e.instancePath === '/name').message;
    assert.strictEqual(byPath(german)['/name'], expected('de'));
    assert.strictEqual(byPath(french)['/name'], expected('fr'));
    assert.notStrictEqual(byPath(german)['/name'], byPath(english)['/name']);
    assert.notStrictEqual(byPath(french)['/name'], byPath(german)['/name']);
    assert.strictEqual(raw.find((e) => e.instancePath === '/name').message, byPath(english)['/name'], 'the cached report is never rewritten');
    assert.deepStrictEqual(localizePlayErrors(raw, undefined), raw, 'no catalog: the errors as they are');
    const before = structuredClone(raw);
    const localized = localizePlayErrors(raw, catalogs.catalogFor('de'));
    assert.deepStrictEqual(raw, before, 'the errors handed in (a host\'s cached report) are never rewritten');
    assert.strictEqual(localized.find((e) => e.instancePath === '/name').message, expected('de'));
  });

  it('asks a failed language again only when what it needs changes', async () => {
    const catalogs = createPlayCatalogs();
    let calls = 0;
    let fail = true;
    const requester = createPackRequester({ catalogs, load: async (code) => { calls++; if (fail) throw new Error('offline'); return load(code); }, onLoaded: () => {} });
    await requester.request(['de']);
    await requester.request(['de']);
    assert.strictEqual(calls, 1, 'the same need does not ask again');
    fail = false;
    await requester.request(['de', 'fr']);
    assert.strictEqual(calls, 3, 'a changed need asks the failed one again');
    assert.notStrictEqual(catalogs.catalogFor('de'), undefined);
    await requester.request(['de', 'fr']);
    assert.strictEqual(calls, 3, 'a loaded language is not asked again');
  });

  it('renders the generated form and its chrome in the reader\'s language', async () => {
    const { catalogs, validator } = createHost();
    catalogs.add('de', await LOADERS.de());
    const english = validator.formLabels('en');
    const german = validator.formLabels('de');
    assert.deepStrictEqual(english, formChromeLabels());
    assert.deepStrictEqual(german, formChromeLabels(catalogs.catalogFor('de')));
    assert.notDeepStrictEqual(german, english);
    const view = validator.formView(PERSON, { name: 'Ada', address: { city: 'Delft' } }, [ADDRESS], 'de');
    assert.ok(view !== null, 'a form for a schema whose field arrives by $ref');
    assert.match(JSON.stringify(view), /city/, 'the referenced document\'s field is in the form');
    assert.strictEqual(createPlayValidator().formView(PERSON, {}, [ADDRESS]), null, 'no form functions, no form');
    assert.strictEqual(createPlayValidator().formLabels('de'), null);
  });

  it('mounts the form in the language the slice runs in, and its view reads it where the kit puts it', async () => {
    const { catalogs, validator } = createHost();
    catalogs.add('de', await LOADERS.de());
    catalogs.add('fr', await LOADERS.fr());
    const shown = { ...PLAY_START, ...loadExample('validate-locale-fr'), dataView: 'form', dataValue: {} };
    const form = playDataForm(validator, withPlayLocale(shown, 'de'));
    assert.ok(form !== null && form.dataForm !== null);
    assert.deepStrictEqual(form.formLabels, formChromeLabels(catalogs.catalogFor('fr')), 'the example\'s own language, not the reader\'s');
    assert.deepStrictEqual(playDataForm(validator, withPlayLocale({ ...shown, exampleLocale: null }, 'de'))?.formLabels,
      formChromeLabels(catalogs.catalogFor('de')), 'the reader\'s language otherwise');
    assert.strictEqual(playDataForm(validator, { ...shown, dataView: 'json' }), null, 'the JSON pane: no form');
    assert.strictEqual(playDataForm(validator, { ...PLAY_START, ...loadExample('path-store'), dataView: 'form' }), null, 'not the validate engine');
    const rules = createFormView(PLAY_FORM_VIEW);
    assert.ok(rules.length > 0);
    const text = JSON.stringify(rules);
    for (const name of Object.keys(playFormActions({ numberValue: FORM_NUMBER_VALUE }))) assert.ok(text.includes(name), `the view writes through ${name}`);
    assert.ok(text.includes('formLabels') && text.includes('dataForm'), 'the view reads where playDataForm mounts');
  });

  it('runs a slice in the reader\'s language; an example made to show one keeps its own', async () => {
    const { catalogs, component } = createHost();
    catalogs.add('de', await LOADERS.de());
    catalogs.add('fr', await LOADERS.fr());
    const slice = { ...PLAY_START, ...loadExample('validate-invalid') };
    assert.strictEqual(withPlayLocale(slice, 'de').config.locale, 'de');
    const shown = { ...PLAY_START, ...loadExample('validate-locale-fr') };
    assert.strictEqual(shown.exampleLocale, 'fr');
    assert.strictEqual(withPlayLocale(shown, 'de').config.locale, 'fr', 'the example shows its own language');
    const english = await runPlay(component, slice, { catalogs });
    const german = await runPlay(component, slice, { lang: 'de', catalogs });
    assert.strictEqual(english.ok, true);
    assert.strictEqual(german.ok, true);
    assert.notDeepStrictEqual(german.panels, english.panels, 'the run speaks the reader\'s language');
    const path = { ...PLAY_START, ...loadExample('path-store') };
    assert.strictEqual(withPlayLocale(path, 'de'), path, 'an engine without a locale option is left alone');
  });

  it('switches an option: the reader\'s choice becomes the language, another option keeps it', () => {
    const shown = { ...PLAY_START, ...loadExample('validate-locale-fr') };
    const picked = switchPlayOption(shown, 'locale', 'de');
    assert.strictEqual(picked.lang, 'de');
    assert.strictEqual(picked.exampleLocale, null, 'the reader\'s choice replaces the example\'s own');
    assert.strictEqual(picked.config.locale, 'de');
    const patch = { ...PLAY_START, ...loadExample('patch-merge') };
    const moved = switchPlayOption(patch, 'mode', 'patch');
    assert.strictEqual(moved.lang, null, 'not the language pane');
    assert.strictEqual(moved.config.mode, 'patch');
    assert.notDeepStrictEqual(moved.source, patch.source, 'the source follows the new mode');
  });

  it('a session never carries the reader\'s language, and a foreign one lands as safe defaults', () => {
    const slice = withPlayLocale({ ...PLAY_START, ...loadExample('validate-invalid'), name: ' My run ' }, 'de');
    assert.strictEqual(slice.config.locale, 'de');
    const session = sessionOf(slice);
    assert.strictEqual(Object.hasOwn(session.config, 'locale'), false);
    const file = sessionDocument(slice);
    assert.deepStrictEqual(sessionFromDocument(JSON.stringify(file)), { name: 'My run', session: sessionToLoaded(session) });
    assert.strictEqual(sessionFilename(slice), 'my-run.play.json');
    assert.strictEqual(sessionFromDocument('[]'), null);
    assert.strictEqual(sessionFromDocument('{"name":"x"}'), null, 'a document naming no engine is no session');
    assert.deepStrictEqual(sessionToLoaded({ engine: 5, source: [], data: 'x', config: null }),
      { engine: PLAY_START.engine, exampleId: null, source: {}, data: {}, config: {} });
    assert.deepStrictEqual(blankSession('constructor'), { engine: PLAY_START.engine, exampleId: null, source: {}, data: {}, config: {} });
    assert.strictEqual(deepLinkExample({ engine: 'patch' }), createPlayComponent().examples.find((e) => e.engine === 'patch')?.id);
    assert.strictEqual(deepLinkExample({ example: 'patch-merge', engine: 'path' }), 'patch-merge', 'an exact example wins');
    assert.strictEqual(deepLinkExample({ example: 'nope' }), null);
    assert.strictEqual(loadExample('nope'), null);
    assert.strictEqual(loadDataset('nope', 0), null);
  });

  it('the generated form\'s actions write number text through the number rule the host hands in', () => {
    const actions = playFormActions({ numberValue: FORM_NUMBER_VALUE });
    assert.deepStrictEqual(Object.keys(actions), ['play/f-input', 'play/f-check', 'play/f-number', 'play/f-json', 'play/f-add', 'play/f-remove']);
    assert.strictEqual(actions['play/f-number'].patch[0].value, FORM_NUMBER_VALUE);
    assert.deepStrictEqual(actions['play/f-number'].patch[0].path, { $concat: ['/play/dataValue', '$payload.pointer'] });
  });
});
