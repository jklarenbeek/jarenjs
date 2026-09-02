//@ts-check

/**
 * Dutch (nl) message catalog for @jarenjs/validate and @jarenjs/forms.
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
 * - `Intl.PluralRules` picks plural categories ("1 teken" / "2 tekens"),
 * - `Intl.NumberFormat` renders numeric limits the Dutch way,
 * - `Intl.ListFormat` renders enum alternatives ("a, b of c"),
 * all held as module-level singletons (allocation discipline).
 */

import {
  formatMessageValue,
  makeNumberRenderer,
  makePluralPicker,
  makeTypeNamer,
  dateNameEntries,
} from './helpers.js';

//#region Intl singletons

const pluralRules = new Intl.PluralRules('nl');
const numberFormat = new Intl.NumberFormat('nl-NL');
const listFormat = new Intl.ListFormat('nl', { style: 'long', type: 'disjunction' });

/** Pick the Dutch singular or plural noun form for a count. */
const plural = makePluralPicker(pluralRules);

/**
 * Render a numeric limit through the Dutch number format; non-numbers
 * (e.g. an unresolved $data pointer) render as-is.
 */
const num = makeNumberRenderer(numberFormat);

/** Dutch names for the JSON Schema type keyword values. */
const TYPE_NAMES = {
  string: 'tekst (string)',
  number: 'getal',
  integer: 'geheel getal',
  boolean: 'boolean',
  array: 'lijst (array)',
  object: 'object',
  null: 'null',
};

/** Type keyword values under their Dutch display name. */
const typeName = makeTypeNamer(TYPE_NAMES);

//#endregion

/**
 * The Dutch catalog. Covers every key of validate's `messagesEn`, every
 * `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, the
 * `JQ2xxx` codes reachable through `$query`, and every `contract/*`
 * wire-error msgid of `@jarenjs/contract`'s `contractMessagesEn`.
 * @type {Record<string, string | ((params: any, error?: object) => string)>}
 */
export const nl = {
  //#region @jarenjs/validate (document voice)
  type: (p) => p.types
    ? `moet een van de volgende typen zijn: ${p.types.join(', ')}`
    : `moet een ${typeName(p.type)} zijn`,
  required: (p) => p.missingProperty
    ? `moet de verplichte eigenschap '${p.missingProperty}' bevatten`
    : 'moet de verplichte eigenschappen bevatten',
  minimum: (p) => `moet ${p.comparison} ${num(p.limit)} zijn`,
  maximum: (p) => `moet ${p.comparison} ${num(p.limit)} zijn`,
  exclusiveMinimum: (p) => `moet ${p.comparison} ${num(p.limit)} zijn`,
  exclusiveMaximum: (p) => `moet ${p.comparison} ${num(p.limit)} zijn`,
  multipleOf: (p) => `moet een veelvoud van ${num(p.multipleOf)} zijn`,
  minLength: (p) => `mag niet minder dan ${num(p.limit)} ${plural(p.limit, 'teken', 'tekens')} bevatten`,
  maxLength: (p) => `mag niet meer dan ${num(p.limit)} ${plural(p.limit, 'teken', 'tekens')} bevatten`,
  pattern: 'moet overeenkomen met patroon "{pattern}"',
  additionalProperties: (p) => p.additionalProperty
    ? `mag de extra eigenschap '${p.additionalProperty}' niet bevatten`
    : 'mag geen extra eigenschappen bevatten',
  minProperties: (p) => `mag niet minder dan ${num(p.limit)} ${plural(p.limit, 'eigenschap', 'eigenschappen')} bevatten`,
  maxProperties: (p) => `mag niet meer dan ${num(p.limit)} ${plural(p.limit, 'eigenschap', 'eigenschappen')} bevatten`,
  minItems: (p) => `mag niet minder dan ${num(p.limit)} ${plural(p.limit, 'item', 'items')} bevatten`,
  maxItems: (p) => `mag niet meer dan ${num(p.limit)} ${plural(p.limit, 'item', 'items')} bevatten`,
  uniqueItems: 'mag geen dubbele items bevatten',
  contains: 'moet ten minste één geldig item bevatten',
  items: 'de items van de lijst zijn ongeldig',
  allOf: "moet aan alle subschema's voldoen",
  anyOf: 'moet aan een subschema in anyOf voldoen',
  oneOf: 'moet aan precies één subschema in oneOf voldoen',
  not: 'mag NIET aan het subschema voldoen',
  format: 'moet overeenkomen met formaat "{format}"',
  if: 'moet aan het "if"-schema voldoen',
  then: 'moet aan het "then"-schema voldoen',
  else: 'moet aan het "else"-schema voldoen',
  'false schema': 'booleaans schema false is altijd ongeldig',
  $query: (p) => p.code
    ? `de '$query'-assertie gaf ${p.code} op '${p.docPath}'`
    : "moet aan de '$query'-assertie voldoen",
  JQ2001: (p) => `de '$query'-assertie kon niet worden berekend (${p.code} op '${p.docPath}')`,
  JQ2003: (p) => `de '$query'-assertie gaf meerdere resultaten (${p.code} op '${p.docPath}')`,
  //#endregion

  //#region @jarenjs/forms (second-person field voice)
  'form/required': 'Dit veld is verplicht',
  'form/type': (p) => `Moet een ${typeName(p.type)} zijn`,
  'form/const': (p) => `Moet ${formatMessageValue(p.constValue)} zijn`,
  'form/enum': (p) => `Moet ${Array.isArray(p.enumValues) ? listFormat.format(p.enumValues.map(formatMessageValue)) : formatMessageValue(p.enumValues)} zijn`,
  'form/minLength': (p) => `Moet ten minste ${num(p.limit)} ${plural(p.limit, 'teken', 'tekens')} bevatten (nu ${num(p.len)})`,
  'form/maxLength': (p) => `Mag ten hoogste ${num(p.limit)} ${plural(p.limit, 'teken', 'tekens')} bevatten (nu ${num(p.len)})`,
  'form/pattern': 'Moet overeenkomen met patroon {pattern}',
  'form/format': (p) => `Moet een geldige ${p.format} zijn`,
  'form/minimum': (p) => `Moet ten minste ${num(p.limit)} zijn`,
  'form/maximum': (p) => `Mag ten hoogste ${num(p.limit)} zijn`,
  'form/exclusiveMinimum': (p) => `Moet groter zijn dan ${num(p.limit)}`,
  'form/exclusiveMaximum': (p) => `Moet kleiner zijn dan ${num(p.limit)}`,
  'form/multipleOf': (p) => `Moet een veelvoud van ${num(p.multipleOf)} zijn`,
  'form/minItems': (p) => `Moet ten minste ${num(p.limit)} ${plural(p.limit, 'item', 'items')} bevatten`,
  'form/maxItems': (p) => `Mag ten hoogste ${num(p.limit)} ${plural(p.limit, 'item', 'items')} bevatten`,
  'form/uniqueItems': 'Items moeten uniek zijn',
  'form/minProperties': (p) => `Moet ten minste ${num(p.limit)} ${plural(p.limit, 'eigenschap', 'eigenschappen')} bevatten`,
  'form/maxProperties': (p) => `Mag ten hoogste ${num(p.limit)} ${plural(p.limit, 'eigenschap', 'eigenschappen')} bevatten`,
  'x-form/assert': 'Ongeldige waarde',
  'form/addItem': 'Item toevoegen',
  'form/removeItem': 'Item verwijderen',
  //#endregion

  //#region @jarenjs/contract (wire-error voice)
  'contract/not-found': 'geen enkele operatie komt overeen met de methode en het pad van het verzoek',
  'contract/method-not-allowed': 'het pad wordt onder andere methoden bediend: {allow}',
  'contract/body-too-large': 'de verzoekbody van operatie {op} overschrijdt de limiet van {limit} bytes',
  'contract/unsupported-media': "operatie {op} accepteert alleen {media}-body's",
  'contract/malformed-json': 'de verzoekbody van operatie {op} is geen geldige JSON',
  'contract/invalid-input': 'de invoer van operatie {op} is ongeldig',
  'contract/idempotency-key-required': 'operatie {op} vereist een Idempotency-Key-header',
  'contract/handler-failed': 'operatie {op} is mislukt',
  'contract/idempotency-conflict': 'de Idempotency-Key van operatie {op} conflicteert met een eerder verzoek ({kind})',
  'contract/invalid-output': 'operatie {op} heeft een antwoord geproduceerd dat het contract schendt',
  'contract/malformed-path': 'het verzoekpad bevat een misvormde procent-escape',
  'contract/malformed-query': 'de querystring is niet te decoderen',
  'contract/not-implemented': 'operatie {op} is niet geïmplementeerd op deze server',
  'contract/precondition-failed': 'de If-Match-voorwaarde van operatie {op} is niet vervuld',
  'contract/invalid-header': 'de {header}-header van operatie {op} is ongeldig',
  'contract/handler-error': 'operatie {op} is mislukt met {code}',
  'contract/client-invalid-input': 'de invoer van operatie {op} is ongeldig; er is niets verzonden',
  'contract/network': 'het verzoek van {op} is niet voltooid ({name})',
  'contract/cancelled': 'het verzoek van operatie {op} is geannuleerd',
  'contract/invalid-response': 'het antwoord van operatie {op} schendt het contract',
  'contract/key-storage-failed': 'de idempotentiesleutel van operatie {op} kon niet worden opgeslagen; er is niets verzonden',
  'contract/undeclared-response': 'operatie {op} antwoordde met een niet-gedeclareerd antwoord (status {status})',
  'contract/not-a-contract': 'de server beschrijft contract {id} niet op zijn well-known-pad',
  'contract/incompatible': 'de server spreekt versie {server} van contract {id}; deze client spreekt {client} en geen van beide einden verklaart de ander compatibel',
  'contract/host-failed': 'operatie {op} is mislukt in de host voordat een uitkomst werd geproduceerd',
  'contract/local-handler-failed': 'operatie {op} is mislukt in de bedienende host',
  'contract/unknown-operation': 'het verzoek noemt geen operatie die op dit kanaal wordt bediend',
  'contract/port-timeout': 'operatie {op} kreeg binnen {ms} ms geen antwoord op het kanaal',
  'contract/malformed-frame': 'het antwoordframe van operatie {op} is misvormd',
  'contract/channel-closed': 'het kanaal van operatie {op} is gesloten',
  'contract/not-a-stream': 'de server beantwoordde het abonnement van operatie {op} met een antwoord dat geen stream is',
  'contract/invalid-snapshot': 'operatie {op} heeft een momentopname geproduceerd die het contract schendt',
  'contract/seq-regression': 'de stream van operatie {op} heeft de seq-volgorde geschonden',
  'contract/stream-error': 'de stream van operatie {op} is geëindigd met een serverfout ({code})',
  'contract/heartbeat-missed': 'de stream van operatie {op} is {ms} ms stil gebleven',
  'contract/slow-consumer': 'de stream van operatie {op} is geëindigd: de afnemer bleef achter bij zijn begrensde wachtrij',
  'contract/reconnect-exhausted': 'de stream van operatie {op} kon na {attempts} pogingen niet worden hersteld (laatste: {lastCode})',
  //#endregion

  //#region calendar language (the date names, relative phrasing and
  //   format display names of @jarenjs/locales' date adapter)
  // 'uur' and 'jaar' do not take a plural after a numeral, so those two
  // units repeat the same noun rather than pretending to agree.
  ...dateNameEntries({
    months: [
      'januari', 'februari', 'maart', 'april', 'mei', 'juni',
      'juli', 'augustus', 'september', 'oktober', 'november', 'december',
    ],
    monthsShort: [
      'jan', 'feb', 'mrt', 'apr', 'mei', 'jun',
      'jul', 'aug', 'sep', 'okt', 'nov', 'dec',
    ],
    weekdays: [
      'zondag', 'maandag', 'dinsdag', 'woensdag',
      'donderdag', 'vrijdag', 'zaterdag',
    ],
    weekdaysShort: [
      'zo', 'ma', 'di', 'wo', 'do', 'vr', 'za',
    ],
    meridiem: ['a.m.', 'p.m.'],
  }),
  'date/relative/second/past': (p) => `${num(p.value)} ${plural(p.value, 'seconde', 'seconden')} geleden`,
  'date/relative/second/future': (p) => `over ${num(p.value)} ${plural(p.value, 'seconde', 'seconden')}`,
  'date/relative/minute/past': (p) => `${num(p.value)} ${plural(p.value, 'minuut', 'minuten')} geleden`,
  'date/relative/minute/future': (p) => `over ${num(p.value)} ${plural(p.value, 'minuut', 'minuten')}`,
  'date/relative/hour/past': (p) => `${num(p.value)} ${plural(p.value, 'uur', 'uur')} geleden`,
  'date/relative/hour/future': (p) => `over ${num(p.value)} ${plural(p.value, 'uur', 'uur')}`,
  'date/relative/day/past': (p) => `${num(p.value)} ${plural(p.value, 'dag', 'dagen')} geleden`,
  'date/relative/day/future': (p) => `over ${num(p.value)} ${plural(p.value, 'dag', 'dagen')}`,
  'date/relative/week/past': (p) => `${num(p.value)} ${plural(p.value, 'week', 'weken')} geleden`,
  'date/relative/week/future': (p) => `over ${num(p.value)} ${plural(p.value, 'week', 'weken')}`,
  'date/relative/month/past': (p) => `${num(p.value)} ${plural(p.value, 'maand', 'maanden')} geleden`,
  'date/relative/month/future': (p) => `over ${num(p.value)} ${plural(p.value, 'maand', 'maanden')}`,
  'date/relative/year/past': (p) => `${num(p.value)} ${plural(p.value, 'jaar', 'jaar')} geleden`,
  'date/relative/year/future': (p) => `over ${num(p.value)} ${plural(p.value, 'jaar', 'jaar')}`,
  'date/relative/now': 'nu',
  'date/relative/yesterday': 'gisteren',
  'date/relative/today': 'vandaag',
  'date/relative/tomorrow': 'morgen',
  'format/name/date': 'datum',
  'format/name/time': 'tijd',
  'format/name/date-time': 'datum en tijd',
  'format/name/iso-date': 'ISO-datum',
  'format/name/iso-time': 'ISO-tijd',
  'format/name/iso-date-time': 'ISO-datum en -tijd',
  //#endregion
};
