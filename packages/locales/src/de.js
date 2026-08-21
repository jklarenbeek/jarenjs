//@ts-check

/**
 * German (de) message catalog for @jarenjs/validate and @jarenjs/forms.
 *
 * A catalog is a plain flat object `{ [key]: closure | template string }`;
 * compile it with `compileMessageCatalog` from either consumer package
 * and hand it to `localizeErrors` (validate) or the `catalog` parameters
 * of `validateField` / `evaluateFormRules` (forms). A pack imports only
 * the shared rendering helpers; key parity with the built-in English
 * catalogs is enforced by tests in the repo, not by imports.
 *
 * Globalization mechanics (the pack-authoring pattern - see
 * packages/validate/docs/ERROR-MESSAGES.md):
 * - `Intl.PluralRules` picks plural categories ("1 Eigenschaft" /
 *   "2 Eigenschaften"; "Zeichen" is invariant and needs none),
 * - `Intl.NumberFormat` renders numeric limits the German way,
 * - `Intl.ListFormat` renders enum alternatives ("a, b oder c"),
 * all held as module-level singletons (allocation discipline).
 */

import {
  formatMessageValue,
  makeNumberRenderer,
  makePluralPicker,
  makeTypeNamer,
} from './helpers.js';

//#region Intl singletons

const pluralRules = new Intl.PluralRules('de');
const numberFormat = new Intl.NumberFormat('de-DE');
const listFormat = new Intl.ListFormat('de', { style: 'long', type: 'disjunction' });

/** Pick the German singular or plural noun form for a count. */
const plural = makePluralPicker(pluralRules);

/**
 * Render a numeric limit through the German number format; non-numbers
 * (e.g. an unresolved $data pointer) render as-is.
 */
const num = makeNumberRenderer(numberFormat);

/** German names (with article) for the JSON Schema type keyword values. */
const TYPE_NAMES = {
  string: 'eine Zeichenkette (string)',
  number: 'eine Zahl',
  integer: 'eine ganze Zahl',
  boolean: 'ein boolescher Wert',
  array: 'eine Liste (array)',
  object: 'ein Objekt',
  null: 'null',
};

/** Type keyword values under their German display name, article included. */
const typeName = makeTypeNamer(TYPE_NAMES);

//#endregion

/**
 * The German catalog. Covers every key of validate's `messagesEn`, every
 * `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, the
 * `JQ2xxx` codes reachable through `$query`, and every `contract/*`
 * wire-error msgid of `@jarenjs/contract`'s `contractMessagesEn`.
 * @type {Record<string, string | ((params: any, error?: object) => string)>}
 */
export const de = {
  //#region @jarenjs/validate (document voice)
  type: (p) => p.types
    ? `muss einer der folgenden Typen sein: ${p.types.join(', ')}`
    : `muss ${typeName(p.type)} sein`,
  required: (p) => p.missingProperty
    ? `muss die Pflichteigenschaft '${p.missingProperty}' enthalten`
    : 'muss die Pflichteigenschaften enthalten',
  minimum: (p) => `muss ${p.comparison} ${num(p.limit)} sein`,
  maximum: (p) => `muss ${p.comparison} ${num(p.limit)} sein`,
  exclusiveMinimum: (p) => `muss ${p.comparison} ${num(p.limit)} sein`,
  exclusiveMaximum: (p) => `muss ${p.comparison} ${num(p.limit)} sein`,
  multipleOf: (p) => `muss ein Vielfaches von ${num(p.multipleOf)} sein`,
  minLength: (p) => `darf nicht weniger als ${num(p.limit)} Zeichen enthalten`,
  maxLength: (p) => `darf nicht mehr als ${num(p.limit)} Zeichen enthalten`,
  pattern: 'muss dem Muster "{pattern}" entsprechen',
  additionalProperties: (p) => p.additionalProperty
    ? `darf die zusätzliche Eigenschaft '${p.additionalProperty}' nicht enthalten`
    : 'darf keine zusätzlichen Eigenschaften enthalten',
  minProperties: (p) => `darf nicht weniger als ${num(p.limit)} ${plural(p.limit, 'Eigenschaft', 'Eigenschaften')} enthalten`,
  maxProperties: (p) => `darf nicht mehr als ${num(p.limit)} ${plural(p.limit, 'Eigenschaft', 'Eigenschaften')} enthalten`,
  minItems: (p) => `darf nicht weniger als ${num(p.limit)} ${plural(p.limit, 'Element', 'Elemente')} enthalten`,
  maxItems: (p) => `darf nicht mehr als ${num(p.limit)} ${plural(p.limit, 'Element', 'Elemente')} enthalten`,
  uniqueItems: 'darf keine doppelten Elemente enthalten',
  contains: 'muss mindestens ein gültiges Element enthalten',
  items: 'die Elemente der Liste sind ungültig',
  allOf: 'muss allen Teilschemata entsprechen',
  anyOf: 'muss einem Teilschema in anyOf entsprechen',
  oneOf: 'muss genau einem Teilschema in oneOf entsprechen',
  not: 'darf dem Teilschema NICHT entsprechen',
  format: 'muss dem Format "{format}" entsprechen',
  if: 'muss dem "if"-Schema entsprechen',
  then: 'muss dem "then"-Schema entsprechen',
  else: 'muss dem "else"-Schema entsprechen',
  'false schema': 'das boolesche Schema false ist immer ungültig',
  $query: (p) => p.code
    ? `die '$query'-Assertion meldete ${p.code} bei '${p.docPath}'`
    : "muss die '$query'-Assertion erfüllen",
  JQ2001: (p) => `die '$query'-Assertion konnte nicht ausgewertet werden (${p.code} bei '${p.docPath}')`,
  JQ2003: (p) => `die '$query'-Assertion lieferte mehrere Ergebnisse (${p.code} bei '${p.docPath}')`,
  //#endregion

  //#region @jarenjs/forms (second-person field voice)
  'form/required': 'Dieses Feld ist erforderlich',
  'form/type': (p) => `Muss ${typeName(p.type)} sein`,
  'form/const': (p) => `Muss ${formatMessageValue(p.constValue)} sein`,
  'form/enum': (p) => `Muss ${Array.isArray(p.enumValues) ? listFormat.format(p.enumValues.map(formatMessageValue)) : formatMessageValue(p.enumValues)} sein`,
  'form/minLength': (p) => `Muss mindestens ${num(p.limit)} Zeichen enthalten (derzeit ${num(p.len)})`,
  'form/maxLength': (p) => `Darf höchstens ${num(p.limit)} Zeichen enthalten (derzeit ${num(p.len)})`,
  'form/pattern': 'Muss dem Muster {pattern} entsprechen',
  'form/format': (p) => `Muss dem Format ${p.format} entsprechen`,
  'form/minimum': (p) => `Muss mindestens ${num(p.limit)} sein`,
  'form/maximum': (p) => `Darf höchstens ${num(p.limit)} sein`,
  'form/exclusiveMinimum': (p) => `Muss größer als ${num(p.limit)} sein`,
  'form/exclusiveMaximum': (p) => `Muss kleiner als ${num(p.limit)} sein`,
  'form/multipleOf': (p) => `Muss ein Vielfaches von ${num(p.multipleOf)} sein`,
  'form/minItems': (p) => `Muss mindestens ${num(p.limit)} ${plural(p.limit, 'Element', 'Elemente')} enthalten`,
  'form/maxItems': (p) => `Darf höchstens ${num(p.limit)} ${plural(p.limit, 'Element', 'Elemente')} enthalten`,
  'form/uniqueItems': 'Die Elemente müssen eindeutig sein',
  'form/minProperties': (p) => `Muss mindestens ${num(p.limit)} ${plural(p.limit, 'Eigenschaft', 'Eigenschaften')} enthalten`,
  'form/maxProperties': (p) => `Darf höchstens ${num(p.limit)} ${plural(p.limit, 'Eigenschaft', 'Eigenschaften')} enthalten`,
  'x-form/assert': 'Ungültiger Wert',
  'form/addItem': 'Element hinzufügen',
  'form/removeItem': 'Element entfernen',
  //#endregion

  //#region @jarenjs/contract (wire-error voice)
  'contract/not-found': 'keine Operation entspricht Methode und Pfad der Anfrage',
  'contract/method-not-allowed': 'der Pfad wird unter anderen Methoden bedient: {allow}',
  'contract/body-too-large': 'der Anfragekörper der Operation {op} überschreitet sein Limit von {limit} Bytes',
  'contract/unsupported-media': 'die Operation {op} akzeptiert nur {media}-Körper',
  'contract/malformed-json': 'der Anfragekörper der Operation {op} ist kein gültiges JSON',
  'contract/invalid-input': 'die Eingabe der Operation {op} ist ungültig',
  'contract/idempotency-key-required': 'die Operation {op} erfordert einen Idempotency-Key-Header',
  'contract/handler-failed': 'die Operation {op} ist fehlgeschlagen',
  'contract/idempotency-conflict': 'der Idempotency-Key der Operation {op} steht im Konflikt mit einer früheren Anfrage ({kind})',
  'contract/invalid-output': 'die Operation {op} hat eine Antwort erzeugt, die ihren Vertrag verletzt',
  'contract/malformed-path': 'der Anfragepfad enthält eine fehlerhafte Prozent-Escape-Sequenz',
  'contract/malformed-query': 'der Query-String ist nicht dekodierbar',
  'contract/not-implemented': 'die Operation {op} ist auf diesem Server nicht implementiert',
  'contract/precondition-failed': 'die If-Match-Vorbedingung der Operation {op} ist fehlgeschlagen',
  'contract/invalid-header': 'der {header}-Header der Operation {op} ist ungültig',
  'contract/handler-error': 'die Operation {op} ist mit {code} fehlgeschlagen',
  'contract/client-invalid-input': 'die Eingabe der Operation {op} ist ungültig; nichts wurde gesendet',
  'contract/network': 'die Anfrage von {op} wurde nicht abgeschlossen ({name})',
  'contract/cancelled': 'die Anfrage der Operation {op} wurde abgebrochen',
  'contract/invalid-response': 'die Antwort der Operation {op} verletzt ihren Vertrag',
  'contract/key-storage-failed': 'der Idempotenzschlüssel der Operation {op} konnte nicht gespeichert werden; nichts wurde gesendet',
  'contract/undeclared-response': 'die Operation {op} hat mit einer nicht deklarierten Antwort geantwortet (Status {status})',
  'contract/not-a-contract': 'der Server beschreibt den Vertrag {id} an seinem Well-known-Pfad nicht',
  'contract/incompatible': 'der Server spricht Version {server} des Vertrags {id}; dieser Client spricht {client}, und keine Seite erklärt die andere für kompatibel',
  'contract/host-failed': 'die Operation {op} ist im Host fehlgeschlagen, bevor ein Ergebnis erzeugt wurde',
  'contract/local-handler-failed': 'die Operation {op} ist im bedienenden Host fehlgeschlagen',
  'contract/unknown-operation': 'die Anfrage nennt keine auf diesem Kanal bediente Operation',
  'contract/port-timeout': 'die Operation {op} erhielt innerhalb von {ms} ms keine Antwort auf dem Kanal',
  'contract/malformed-frame': 'der Antwortrahmen der Operation {op} ist fehlerhaft',
  'contract/channel-closed': 'der Kanal der Operation {op} ist geschlossen',
  'contract/not-a-stream': 'der Server hat das Abonnement der Operation {op} mit einer Antwort beantwortet, die kein Stream ist',
  'contract/invalid-snapshot': 'die Operation {op} hat einen Schnappschuss erzeugt, der ihren Vertrag verletzt',
  'contract/seq-regression': 'der Stream der Operation {op} hat seine seq-Reihenfolge verletzt',
  'contract/stream-error': 'der Stream der Operation {op} endete mit einem Serverfehler ({code})',
  'contract/heartbeat-missed': 'der Stream der Operation {op} blieb {ms} ms lang still',
  //#endregion
};
