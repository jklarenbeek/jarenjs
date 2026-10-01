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
 * `JQ2xxx` codes reachable through `$query`, every `contract/*`
 * wire-error msgid of `@jarenjs/contract`'s `contractMessagesEn`, and
 * every `query/*` message of `@jarenjs/json`'s `queryMessagesEn`.
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
  'form/jsonPlaceholder': 'Introduce un valor JSON',
  //#endregion

  //#region @jarenjs/contract (wire-error voice)
  'contract/not-found': 'ninguna operación coincide con el método y la ruta de la solicitud',
  'contract/method-not-allowed': 'la ruta se sirve bajo otros métodos: {allow}',
  'contract/body-too-large': 'el cuerpo de la solicitud de la operación {op} supera su límite de {limit} bytes',
  'contract/unsupported-media': 'la operación {op} solo acepta cuerpos {media}',
  'contract/malformed-json': 'el cuerpo de la solicitud de la operación {op} no es JSON válido',
  'contract/malformed-body': 'el cuerpo de la solicitud de la operación {op} no es texto UTF-8 válido',
  'contract/invalid-input': 'la entrada de la operación {op} no es válida',
  'contract/idempotency-key-required': 'la operación {op} requiere una cabecera Idempotency-Key',
  'contract/handler-failed': 'la operación {op} falló',
  'contract/idempotency-conflict': 'la Idempotency-Key de la operación {op} entra en conflicto con una solicitud anterior ({kind})',
  'contract/invalid-output': 'la operación {op} produjo una respuesta que viola su contrato',
  'contract/malformed-path': 'la ruta de la solicitud contiene un escape porcentual mal formado, o un segmento que es . o ..',
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

  //#region @jarenjs/json query engine (diagnostic voice)
  'query/reason': '{reason}',
  'query/detail': '{detail}',
  'query/item/sequence': 'una secuencia de {count} elementos',
  'query/item/empty': 'la secuencia vacía',
  'query/item/null': 'null',
  'query/item/array': 'una lista',
  'query/item/object': 'un objeto',
  'query/item/string': 'una cadena',
  'query/item/number': 'un número',
  'query/item/boolean': 'un booleano',
  'query/item/other': 'un valor {type}',
  'query/mixed-keys': 'un objeto no puede mezclar claves $-prefixed y claves simples',
  'query/unknown-operator': "operador desconocido '{key}'",
  'query/unknown-operator-suggest': "operador desconocido '{key}' (¿quisiste decir '{suggestion}'?)",
  'query/unknown-operator-use': "operador desconocido '{key}' (usa {use})",
  'query/unknown-operator-none': "operador desconocido '{key}' (ningún operador hace esto en jaren-query)",
  'query/use/head-of-reverse': '$head sobre $reverse',
  'query/use/jsonpath-filter': 'un filtro JSONPath como $[?(@.x > 1)] o $where dentro de un $for',
  'query/use/for-return': 'una frase $for con $return',
  'query/use/for-phrase': 'una frase $for',
  'query/use/sort-objects': '$sort (ordena escalares; los objetos se ordenan con un $for sobre una clave ordenada)',
  'query/use/sort-scalars': '$sort (solo escalares)',
  'query/use/entries-get': '$entries y luego $get',
  'query/use/geo-parse-text': '$geo-parse para leer uno, $geo-text para escribir uno',
  'query/use/bbox-intersects': '$bbox-intersects (solo cajas envolventes — la superposición real se omite deliberadamente)',
  'query/use/renderer': 'el renderizador del mapa — el lenguaje no puede producir ninguna coordenada proyectada, así que una medición nunca puede recaer sobre una; aquí la medición es geodésica',
  'query/use/renderer-project': "el renderizador del mapa, igual que para '$project'",
  'query/use/similarity': '$similarity (cuanto mayor, más cercano; no hay ninguna métrica de distancia)',
  'query/use/knn-desc': "$orderby sobre una clave $similarity con $dir 'desc' y luego $subsequence para los k primeros",
  'query/use/knn': '$orderby sobre una clave $similarity y luego $subsequence',
  'query/use/top-k': '$orderby y luego $subsequence',
  'query/use/resample-fill': "$resample con un 'fill'",
  'query/use/resample-locf': "$resample con fill 'locf'",
  'query/use/resample-linear': "$resample con fill 'linear'",
  'query/use/rolling-mean': "$rolling con aggregate 'mean'",
  'query/phrase-keys': 'combinación no válida de claves de frase ({keys})',
  'query/phrase-alone': "'{key}' no puede formar una frase por sí solo",
  'query/operands-array': "'{op}' acepta una lista de expresiones",
  'query/operands-exactly': "'{op}' acepta exactamente {min} operando(s), recibió {count}",
  'query/operands-at-least': "'{op}' acepta al menos {min} operando(s), recibió {count}",
  'query/operands-range': "'{op}' acepta de {min} a {max} operando(s), recibió {count}",
  'query/variable-name-expected': 'se esperaba una cadena con un nombre de variable',
  'query/variable-name-invalid': "'{name}' no es un nombre de variable válido",
  'query/variable-duplicate': "vinculación duplicada de la variable '{name}' dentro de una misma frase",
  'query/bindings-object': "'{clause}' acepta un objeto de vinculaciones de variables",
  'query/bindings-empty': "'{clause}' requiere al menos una vinculación",
  'query/extended-let': "la forma extendida de vinculación no está disponible en '$let'",
  'query/extended-quantifier': 'la forma extendida de vinculación no está disponible en los cuantificadores',
  'query/window-kind': "'$window' debe ser 'tumbling' o 'sliding'",
  'query/window-size-required': "una vinculación '$window' requiere '$size'",
  'query/window-size': "'$size' debe ser un número entero positivo",
  'query/window-step': "'$step' debe ser un número entero positivo",
  'query/window-required': "'$size'/'$step' requieren '$window'",
  'query/for-key': "'{key}' no es una clave válida de una vinculación '$for' extendida",
  'query/for-in-required': "una vinculación '$for' extendida requiere '$in'",
  'query/for-at': "'$at' acepta una cadena con un nombre de variable",
  'query/for-allowing-empty': "'$allowing-empty' acepta un booleano",
  'query/orderby-spec': "'$orderby' acepta una especificación de clave o una lista no vacía de especificaciones de clave",
  'query/orderby-spec-key': "'{key}' no es una clave válida de una especificación de clave de $orderby",
  'query/orderby-spec-key-required': "una especificación de clave de $orderby explícita requiere '$key'",
  'query/orderby-dir': "'$dir' debe ser 'asc' o 'desc'",
  'query/orderby-empty': "'$empty' debe ser 'least' o 'greatest'",
  'query/collation-name': "'$collation' debe ser el nombre de una intercalación registrada",
  'query/collation-unregistered': "'$collation' nombra una intercalación no registrada '{name}'",
  'query/fold-binding': "'$fold' acepta exactamente una vinculación de acumulador",
  'query/as-object': "'$as' acepta un objeto cuyos miembros asocian nombres de variable con esquemas",
  'query/as-empty': "'$as' requiere al menos un miembro",
  'query/as-unbound': "'$as' nombra '{name}', que el '$for'/'$let' de esta frase no vincula",
  'query/count-variable': "'$count' acepta una cadena con un nombre de variable",
  'query/map-entry': 'una entrada de $map debe ser una lista de exactamente dos expresiones',
  'query/call-arguments': "'$call' requiere ['name', ...expresiones de argumento]",
  'query/call-unregistered': "'$call' nombra una función no registrada '{name}'",
  'query/apply-arguments': "'$apply' acepta [selector] o [selector, modo]",
  'query/apply-mode': "el modo de '$apply' debe ser una cadena literal",
  'query/document-value': 'un documento de consulta no puede contener un valor {type}',
  'query/invalid-path': "'{path}' no es una ruta ni un escape válidos",
  'query/invalid-path-detail': "'{path}' no es una ruta válida: {detail}",
  'query/unbound-variable': "'${name}' no es una variable vinculada por una frase envolvente ni un parámetro externo declarado (parámetros externos declarados: {declared})",
  'query/unbound-variable-closed': "'${name}' no es una variable vinculada por una frase envolvente ni un parámetro externo declarado (esta consulta se compiló en modo de mundo cerrado, sin declarar parámetros externos)",
  'query/version-unknown': 'versión {version} desconocida del formato de consulta',
  'query/version-envelope': "el sobre de versión requiere exactamente las claves '$query' y '$expr'",
  'query/schema-no-compiler': 'los operadores de esquema requieren un compilador de pruebas de tipo (options.compileTypeTest)',
  'query/schema-invalid': 'literal de esquema no válido: {detail}',
  'query/schema-no-predicate': 'el compilador de pruebas de tipo no devolvió una función predicado',
  'query/depth-limit': 'la consulta anida expresiones a {depth} niveles de profundidad, más que limits.depth ({limit})',
  'query/spec-member-required': "'{name}' necesita un miembro de especificación '{member}'",
  'query/spec-invalid': "especificación de '{name}': {detail}",
  'query/date-pattern': "patrón de '$date-format': {detail}",
  'query/time-bucket-invalid': "'$time-bucket' no válido: {detail}",
  'query/lexical-arguments': '$lexical necesita [proveedor, expresión de texto, solicitud literal]',
  'query/lexical-unregistered': "el proveedor léxico '{name}' no está registrado",
  'query/lexical-rejected': 'el proveedor léxico rechazó la solicitud',
  'query/lexical-no-request': 'el proveedor léxico no compiló ninguna solicitud',
  'query/series-spec-object': "'{operator}' acepta un objeto de especificación literal, se obtuvo {got}",
  'query/series-spec-member': "'{operator}' no tiene ningún miembro de especificación '{name}'; admite {allowed}",
  'query/series-spec-member-suggest': "'{operator}' no tiene ningún miembro de especificación '{name}' (¿quisiste decir '{suggestion}'?); admite {allowed}",
  'query/series-member-enum': "'{member}' es uno de {allowed}, se obtuvo {got}",
  'query/series-member-number': "'{member}' es un número finito, se obtuvo {got}",
  'query/series-member-instant': "'{member}' es una cantidad de milisegundos desde la época o una cadena RFC 3339, se obtuvo {got}",
  'query/series-member-duration': "'{member}' es una cadena de duración o una cantidad de milisegundos, se obtuvo {got}",
  'query/series-member-path': "'{member}' es una ruta singular dentro de la fila, se obtuvo {got}",
  'query/series-member-path-detail': "miembro '{member}': {detail}",
  'query/series-member-not-path': "'{member}': no es una ruta",
  'query/series-member-whole-row': "'{member}' selecciona la fila entera en lugar de uno de sus miembros",
  'query/series-member-singular': "'{member}' es una ruta singular — un nombre o índice por segmento, sin comodín, descendiente ni filtro",
  'query/series-zone': "'zone' es un nombre de zona horaria IANA, se obtuvo {got}",
  'query/series-zone-provider': "la zona '{zone}' necesita un proveedor de zonas horarias: esta suite no incluye ninguna tzdb, así que una zona con nombre se compila con options.zoneProvider (toParts / toEpoch). 'UTC' y un 'offset' numérico no lo necesitan",
  'query/series-calendar': 'el contexto de calendario: {detail}',
  'query/expected-string': 'se esperaba una cadena, se obtuvo {got}',
  'query/expected-number': 'se esperaba un número, se obtuvo {got}',
  'query/cast-string': 'no se puede convertir {got} en una cadena',
  'query/cast-number': 'no se puede convertir {got} en un número',
  'query/not-json-number': "'{value}' no es un número JSON",
  'query/arithmetic-operand': 'la aritmética requiere un operando numérico, se obtuvo {got}',
  'query/aggregate-not-number': 'los elementos de un agregado deben ser números, se obtuvo {got}',
  'query/aggregate-null': 'un agregado requiere números o cadenas, se obtuvo null',
  'query/minmax-mixed': "los elementos de '$min'/'$max' deben ser todos números o todos cadenas, se obtuvo {got}",
  'query/sort-mixed': "los elementos de '$sort' deben ser todos números o todos cadenas, se obtuvo {got}",
  'query/regex-invalid': "'{pattern}' no es un patrón I-Regexp válido",
  'query/replace-empty-match': "el patrón '{pattern}' de '$replace' coincide con la cadena de longitud cero",
  'query/range-bounds': "los límites de '$range' deben ser enteros seguros, se obtuvo {got}",
  'query/range-guard': "'$range' de {count} elementos supera la salvaguarda de recursos de {limit} elementos",
  'query/index-of-item': "'$index-of' acepta un único elemento de búsqueda, se obtuvo {got}",
  'query/expected-datetime': 'se esperaba una cadena RFC 3339 de fecha, hora o fecha y hora, se obtuvo {got}',
  'query/no-date-component': "'{value}' no contiene ningún componente de fecha",
  'query/no-time-component': "'{value}' no contiene ningún componente de hora",
  'query/calendar-unit': "se esperaba una unidad de calendario ('year', 'month', 'day', ...), se obtuvo {got}",
  'query/expected-duration': 'se esperaba una duración ISO 8601, se obtuvo {got}',
  'query/expected-units': 'se esperaba un número de unidades, se obtuvo {got}',
  'query/expected-date-pattern': 'se esperaba un patrón de fecha, se obtuvo {got}',
  'query/datetime-epoch': "'$datetime' acepta milisegundos desde la época, se obtuvo {got}",
  'query/datetime-range': '{value} está fuera del rango que RFC 3339 puede expresar',
  'query/span-no-date': 'no se puede medir un lapso a partir de un valor sin fecha',
  'query/expected-bucket-width': 'se esperaba un ancho de cubeta, se obtuvo {got}',
  'query/expected-geo': 'se esperaba un valor GeoJSON o una posición [longitud, latitud], se obtuvo {got}',
  'query/expected-wkt': 'se esperaba una cadena Well-Known Text, se obtuvo {got}',
  'query/expected-geohash': 'se esperaba una cadena de celda geohash, se obtuvo {got}',
  'query/geohash-precision': 'una precisión geohash debe ser un número entero de 1 a 12, se obtuvo {got}',
  'query/simplify-tolerance': 'una tolerancia de simplificación es un número no negativo de grados, se obtuvo {got}',
  'query/expected-vector': 'se esperaba un vector (una lista de números), se obtuvo {got}',
  'query/expected-vector-item': 'se esperaba un vector (una lista de números), se obtuvo {got} en el índice {index}',
  'query/expected-series': 'se esperaba una serie (registros con un instante y una lectura), se obtuvo {got}',
  'query/expected-interval': 'se esperaba un registro de intervalo {{ start, end }, se obtuvo {got}',
  'query/member-cardinality': "el miembro '{name}' produjo {count} elementos; un miembro de objeto admite exactamente uno",
  'query/groupby-key': 'una clave de $groupby debe ser la secuencia vacía o un único elemento, se obtuvo {got}',
  'query/lexical-text': 'el texto léxico debe ser una única cadena',
  'query/idiv-zero': "'$idiv' entre cero",
  'query/mod-zero': "'$mod' entre cero",
  'query/ebv-sequence': 'el valor booleano efectivo de una secuencia de dos o más elementos no está definido',
  'query/map-key': 'una clave de $map debe producir una única cadena, se obtuvo {got}',
  'query/orderby-key': 'una clave de $orderby debe ser la secuencia vacía, un número o una cadena, se obtuvo {got}',
  'query/orderby-number-string': 'no se puede ordenar un número frente a una cadena en $orderby',
  'query/orderby-string-number': 'no se puede ordenar una cadena frente a un número en $orderby',
  'query/external-unbound': "el parámetro externo '{name}' no se vinculó",
  'query/assert-failed': "'$assert' falló: {got} no cumple el esquema",
  'query/assert-failed-item': "'$assert' falló: el elemento {index} ({got}) no cumple el esquema",
  'query/as-failed': "la variable '{name}' no superó su esquema '$as': {got} no lo cumple",
  'query/as-failed-item': "la variable '{name}' no superó su esquema '$as': el elemento {index} ({got}) no lo cumple",
  'query/fold-limit': 'un acumulador de plegado superó los {limit} elementos (limits.sequenceItems)',
  'query/phrase-limit': 'una frase materializó más de {limit} elementos (limits.sequenceItems)',
  'query/steps-limit': 'la consulta superó limits.steps ({limit} evaluaciones de expresiones)',
  'query/result-limit': 'el resultado de la consulta tiene {count} elementos, más que limits.resultItems ({limit})',
  'query/function-threw': "la función registrada '{name}' lanzó una excepción: {detail}",
  'query/operator-threw': "el operador registrado '{name}' falló: {detail}",
  'query/input-undefined': 'el documento de entrada es undefined, lo cual no es un valor JSON',
  'query/lexical-threw': 'el proveedor léxico lanzó una excepción',
  'query/lexical-result': 'el proveedor léxico devolvió un resultado no válido o incompleto',
  //#endregion
};
