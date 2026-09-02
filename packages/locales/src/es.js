//@ts-check

/**
 * Spanish (es) message catalog for @jarenjs/validate and @jarenjs/forms.
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
 * - `Intl.PluralRules` picks plural categories, and the singular of
 *   "caracteres" shifts its accent ("1 carácter" / "2 caracteres"),
 * - `Intl.NumberFormat` renders numeric limits the Spanish way,
 * - `Intl.ListFormat` renders enum alternatives ("a, b o c"),
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

const pluralRules = new Intl.PluralRules('es');
const numberFormat = new Intl.NumberFormat('es-ES');
const listFormat = new Intl.ListFormat('es', { style: 'long', type: 'disjunction' });

/** Pick the Spanish singular or plural noun form for a count. */
const plural = makePluralPicker(pluralRules);

/**
 * Render a numeric limit through the Spanish number format; non-numbers
 * (e.g. an unresolved $data pointer) render as-is.
 */
const num = makeNumberRenderer(numberFormat);

/** Spanish names (with article) for the JSON Schema type keyword values. */
const TYPE_NAMES = {
  string: 'una cadena (string)',
  number: 'un número',
  integer: 'un número entero',
  boolean: 'un booleano',
  array: 'una lista (array)',
  object: 'un objeto',
  null: 'null',
};

/** Type keyword values under their Spanish display name, article included. */
const typeName = makeTypeNamer(TYPE_NAMES);

//#endregion

/**
 * The Spanish catalog. Covers every key of validate's `messagesEn`, every
 * `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, the
 * `JQ2xxx` codes reachable through `$query`, and every `contract/*`
 * wire-error msgid of `@jarenjs/contract`'s `contractMessagesEn`.
 * @type {Record<string, string | ((params: any, error?: object) => string)>}
 */
export const es = {
  //#region @jarenjs/validate (document voice)
  type: (p) => p.types
    ? `debe ser uno de los siguientes tipos: ${p.types.join(', ')}`
    : `debe ser ${typeName(p.type)}`,
  required: (p) => p.missingProperty
    ? `debe tener la propiedad obligatoria '${p.missingProperty}'`
    : 'debe tener las propiedades obligatorias',
  minimum: (p) => `debe ser ${p.comparison} ${num(p.limit)}`,
  maximum: (p) => `debe ser ${p.comparison} ${num(p.limit)}`,
  exclusiveMinimum: (p) => `debe ser ${p.comparison} ${num(p.limit)}`,
  exclusiveMaximum: (p) => `debe ser ${p.comparison} ${num(p.limit)}`,
  multipleOf: (p) => `debe ser un múltiplo de ${num(p.multipleOf)}`,
  minLength: (p) => `no debe tener menos de ${num(p.limit)} ${plural(p.limit, 'carácter', 'caracteres')}`,
  maxLength: (p) => `no debe tener más de ${num(p.limit)} ${plural(p.limit, 'carácter', 'caracteres')}`,
  pattern: 'debe coincidir con el patrón "{pattern}"',
  additionalProperties: (p) => p.additionalProperty
    ? `no debe tener la propiedad adicional '${p.additionalProperty}'`
    : 'no debe tener propiedades adicionales',
  minProperties: (p) => `no debe tener menos de ${num(p.limit)} ${plural(p.limit, 'propiedad', 'propiedades')}`,
  maxProperties: (p) => `no debe tener más de ${num(p.limit)} ${plural(p.limit, 'propiedad', 'propiedades')}`,
  minItems: (p) => `no debe tener menos de ${num(p.limit)} ${plural(p.limit, 'elemento', 'elementos')}`,
  maxItems: (p) => `no debe tener más de ${num(p.limit)} ${plural(p.limit, 'elemento', 'elementos')}`,
  uniqueItems: 'no debe tener elementos duplicados',
  contains: 'debe contener al menos un elemento válido',
  items: 'los elementos de la lista no son válidos',
  allOf: 'debe cumplir todos los subesquemas',
  anyOf: 'debe cumplir un subesquema de anyOf',
  oneOf: 'debe cumplir exactamente un subesquema de oneOf',
  not: 'NO debe cumplir el subesquema',
  format: 'debe coincidir con el formato "{format}"',
  if: 'debe cumplir el esquema "if"',
  then: 'debe cumplir el esquema "then"',
  else: 'debe cumplir el esquema "else"',
  'false schema': 'el esquema booleano false siempre es inválido',
  $query: (p) => p.code
    ? `la aserción '$query' produjo ${p.code} en '${p.docPath}'`
    : "debe cumplir la aserción '$query'",
  JQ2001: (p) => `la aserción '$query' no se pudo evaluar (${p.code} en '${p.docPath}')`,
  JQ2003: (p) => `la aserción '$query' produjo varios resultados (${p.code} en '${p.docPath}')`,
  //#endregion

  //#region @jarenjs/forms (second-person field voice)
  'form/required': 'Este campo es obligatorio',
  'form/type': (p) => `Debe ser ${typeName(p.type)}`,
  'form/const': (p) => `Debe ser ${formatMessageValue(p.constValue)}`,
  'form/enum': (p) => `Debe ser ${Array.isArray(p.enumValues) ? listFormat.format(p.enumValues.map(formatMessageValue)) : formatMessageValue(p.enumValues)}`,
  'form/minLength': (p) => `Debe tener al menos ${num(p.limit)} ${plural(p.limit, 'carácter', 'caracteres')} (actualmente ${num(p.len)})`,
  'form/maxLength': (p) => `Debe tener como máximo ${num(p.limit)} ${plural(p.limit, 'carácter', 'caracteres')} (actualmente ${num(p.len)})`,
  'form/pattern': 'Debe coincidir con el patrón {pattern}',
  'form/format': (p) => `Debe cumplir el formato ${p.format}`,
  'form/minimum': (p) => `Debe ser al menos ${num(p.limit)}`,
  'form/maximum': (p) => `Debe ser como máximo ${num(p.limit)}`,
  'form/exclusiveMinimum': (p) => `Debe ser mayor que ${num(p.limit)}`,
  'form/exclusiveMaximum': (p) => `Debe ser menor que ${num(p.limit)}`,
  'form/multipleOf': (p) => `Debe ser un múltiplo de ${num(p.multipleOf)}`,
  'form/minItems': (p) => `Debe tener al menos ${num(p.limit)} ${plural(p.limit, 'elemento', 'elementos')}`,
  'form/maxItems': (p) => `Debe tener como máximo ${num(p.limit)} ${plural(p.limit, 'elemento', 'elementos')}`,
  'form/uniqueItems': 'Los elementos deben ser únicos',
  'form/minProperties': (p) => `Debe tener al menos ${num(p.limit)} ${plural(p.limit, 'propiedad', 'propiedades')}`,
  'form/maxProperties': (p) => `Debe tener como máximo ${num(p.limit)} ${plural(p.limit, 'propiedad', 'propiedades')}`,
  'x-form/assert': 'Valor no válido',
  'form/addItem': 'Añadir elemento',
  'form/removeItem': 'Eliminar elemento',
  //#endregion

  //#region @jarenjs/contract (wire-error voice)
  'contract/not-found': 'ninguna operación coincide con el método y la ruta de la solicitud',
  'contract/method-not-allowed': 'la ruta se sirve bajo otros métodos: {allow}',
  'contract/body-too-large': 'el cuerpo de la solicitud de la operación {op} supera su límite de {limit} bytes',
  'contract/unsupported-media': 'la operación {op} solo acepta cuerpos {media}',
  'contract/malformed-json': 'el cuerpo de la solicitud de la operación {op} no es JSON válido',
  'contract/invalid-input': 'la entrada de la operación {op} no es válida',
  'contract/idempotency-key-required': 'la operación {op} requiere una cabecera Idempotency-Key',
  'contract/handler-failed': 'la operación {op} falló',
  'contract/idempotency-conflict': 'la Idempotency-Key de la operación {op} entra en conflicto con una solicitud anterior ({kind})',
  'contract/invalid-output': 'la operación {op} produjo una respuesta que viola su contrato',
  'contract/malformed-path': 'la ruta de la solicitud contiene un escape porcentual mal formado',
  'contract/malformed-query': 'la cadena de consulta no se puede descodificar',
  'contract/not-implemented': 'la operación {op} no está implementada en este servidor',
  'contract/precondition-failed': 'la precondición If-Match de la operación {op} falló',
  'contract/invalid-header': 'la cabecera {header} de la operación {op} no es válida',
  'contract/handler-error': 'la operación {op} falló con {code}',
  'contract/client-invalid-input': 'la entrada de la operación {op} no es válida; no se envió nada',
  'contract/network': 'la solicitud de {op} no se completó ({name})',
  'contract/cancelled': 'la solicitud de la operación {op} fue cancelada',
  'contract/invalid-response': 'la respuesta de la operación {op} viola su contrato',
  'contract/key-storage-failed': 'la clave de idempotencia de la operación {op} no pudo almacenarse; no se envió nada',
  'contract/undeclared-response': 'la operación {op} respondió con una respuesta no declarada (estado {status})',
  'contract/not-a-contract': 'el servidor no describe el contrato {id} en su ruta well-known',
  'contract/incompatible': 'el servidor habla la versión {server} del contrato {id}; este cliente habla {client} y ningún extremo declara compatible al otro',
  'contract/host-failed': 'la operación {op} falló en el host antes de producirse un resultado',
  'contract/local-handler-failed': 'la operación {op} falló en el host que la sirve',
  'contract/unknown-operation': 'la solicitud no nombra ninguna operación servida en este canal',
  'contract/port-timeout': 'la operación {op} no obtuvo respuesta en el canal en {ms} ms',
  'contract/malformed-frame': 'la trama de respuesta de la operación {op} está mal formada',
  'contract/channel-closed': 'el canal de la operación {op} está cerrado',
  'contract/not-a-stream': 'el servidor respondió a la suscripción de la operación {op} con una respuesta que no es un flujo',
  'contract/invalid-snapshot': 'la operación {op} produjo una instantánea que viola su contrato',
  'contract/seq-regression': 'el flujo de la operación {op} violó el orden de sus seq',
  'contract/stream-error': 'el flujo de la operación {op} terminó con un error del servidor ({code})',
  'contract/heartbeat-missed': 'el flujo de la operación {op} quedó en silencio durante {ms} ms',
  'contract/slow-consumer': 'el flujo de la operación {op} terminó: el consumidor se quedó atrás de su cola acotada',
  'contract/reconnect-exhausted': 'el flujo de la operación {op} no pudo restablecerse tras {attempts} intentos (último: {lastCode})',
  //#endregion

  //#region calendar language (the date names, relative phrasing and
  //   format display names of @jarenjs/locales' date adapter)
  ...dateNameEntries({
    months: [
      'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
      'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
    ],
    monthsShort: [
      'ene', 'feb', 'mar', 'abr', 'may', 'jun',
      'jul', 'ago', 'sept', 'oct', 'nov', 'dic',
    ],
    weekdays: [
      'domingo', 'lunes', 'martes', 'miércoles',
      'jueves', 'viernes', 'sábado',
    ],
    weekdaysShort: [
      'dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb',
    ],
    meridiem: ['a. m.', 'p. m.'],
  }),
  'date/relative/second/past': (p) => `hace ${num(p.value)} ${plural(p.value, 'segundo', 'segundos')}`,
  'date/relative/second/future': (p) => `dentro de ${num(p.value)} ${plural(p.value, 'segundo', 'segundos')}`,
  'date/relative/minute/past': (p) => `hace ${num(p.value)} ${plural(p.value, 'minuto', 'minutos')}`,
  'date/relative/minute/future': (p) => `dentro de ${num(p.value)} ${plural(p.value, 'minuto', 'minutos')}`,
  'date/relative/hour/past': (p) => `hace ${num(p.value)} ${plural(p.value, 'hora', 'horas')}`,
  'date/relative/hour/future': (p) => `dentro de ${num(p.value)} ${plural(p.value, 'hora', 'horas')}`,
  'date/relative/day/past': (p) => `hace ${num(p.value)} ${plural(p.value, 'día', 'días')}`,
  'date/relative/day/future': (p) => `dentro de ${num(p.value)} ${plural(p.value, 'día', 'días')}`,
  'date/relative/week/past': (p) => `hace ${num(p.value)} ${plural(p.value, 'semana', 'semanas')}`,
  'date/relative/week/future': (p) => `dentro de ${num(p.value)} ${plural(p.value, 'semana', 'semanas')}`,
  'date/relative/month/past': (p) => `hace ${num(p.value)} ${plural(p.value, 'mes', 'meses')}`,
  'date/relative/month/future': (p) => `dentro de ${num(p.value)} ${plural(p.value, 'mes', 'meses')}`,
  'date/relative/year/past': (p) => `hace ${num(p.value)} ${plural(p.value, 'año', 'años')}`,
  'date/relative/year/future': (p) => `dentro de ${num(p.value)} ${plural(p.value, 'año', 'años')}`,
  'date/relative/now': 'ahora',
  'date/relative/yesterday': 'ayer',
  'date/relative/today': 'hoy',
  'date/relative/tomorrow': 'mañana',
  'format/name/date': 'fecha',
  'format/name/time': 'hora',
  'format/name/date-time': 'fecha y hora',
  'format/name/iso-date': 'fecha ISO',
  'format/name/iso-time': 'hora ISO',
  'format/name/iso-date-time': 'fecha y hora ISO',
  //#endregion
};
