//@ts-check

/**
 * Russian (ru) message catalog for @jarenjs/validate and @jarenjs/forms.
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
 * - `Intl.PluralRules` picks plural categories. Russian counts split
 *   one/few/many; every counted noun following "менее/более" reads in
 *   the genitive, where only the 'one' category differs ("21 символа" /
 *   "22 символов") and a two-form helper suffices, while the
 *   relative-time nouns take the accusative and need all three,
 * - `Intl.NumberFormat` renders numeric limits the Russian way,
 * - `Intl.ListFormat` renders enum alternatives ("a, b или c"),
 * all held as module-level singletons (allocation discipline).
 */

import {
  formatMessageValue,
  makeNumberRenderer,
  makePluralForms,
  makePluralPicker,
  makeTypeNamer,
  dateNameEntries,
} from './helpers.js';

//#region Intl singletons

const pluralRules = new Intl.PluralRules('ru');
const numberFormat = new Intl.NumberFormat('ru-RU');
const listFormat = new Intl.ListFormat('ru', { style: 'long', type: 'disjunction' });

/**
 * Pick the genitive singular ('символа') or genitive plural
 * ('символов') noun form for a count - the shape every "менее/более
 * N ..." message needs.
 */
const plural = makePluralPicker(pluralRules);

/**
 * Pick the accusative form a counted relative-time noun takes: 'one'
 * recurs at 21, 31 ... and 'few' at 22-24, so the three forms follow the
 * CLDR category rather than the number's last digit.
 */
const caseForms = makePluralForms(pluralRules);

/**
 * Render a numeric limit through the Russian number format; non-numbers
 * (e.g. an unresolved $data pointer) render as-is.
 */
const num = makeNumberRenderer(numberFormat);

/**
 * Russian names for the JSON Schema type keyword values, in the
 * instrumental case ("должно быть строкой").
 */
const TYPE_NAMES = {
  string: 'строкой (string)',
  number: 'числом',
  integer: 'целым числом',
  boolean: 'булевым значением',
  array: 'списком (array)',
  object: 'объектом',
  null: 'null',
};

/** Type keyword values under their Russian display name, instrumental case. */
const typeName = makeTypeNamer(TYPE_NAMES);

//#endregion

/**
 * The Russian catalog. Covers every key of validate's `messagesEn`,
 * every `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, the
 * `JQ2xxx` codes reachable through `$query`, every `contract/*`
 * wire-error msgid of `@jarenjs/contract`'s `contractMessagesEn`, and
 * every `query/*` message of `@jarenjs/json`'s `queryMessagesEn` and every message of its `formulaMessagesEn`.
 * @type {Record<string, string | ((params: any, error?: object) => string)>}
 */
export const ru = {
  //#region @jarenjs/validate (document voice)
  type: (p) => p.types
    ? `должно быть одним из следующих типов: ${p.types.join(', ')}`
    : `должно быть ${typeName(p.type)}`,
  required: (p) => p.missingProperty
    ? `должно содержать обязательное свойство '${p.missingProperty}'`
    : 'должно содержать обязательные свойства',
  minimum: (p) => `должно быть ${p.comparison} ${num(p.limit)}`,
  maximum: (p) => `должно быть ${p.comparison} ${num(p.limit)}`,
  exclusiveMinimum: (p) => `должно быть ${p.comparison} ${num(p.limit)}`,
  exclusiveMaximum: (p) => `должно быть ${p.comparison} ${num(p.limit)}`,
  multipleOf: (p) => `должно быть кратно ${num(p.multipleOf)}`,
  minLength: (p) => `не должно содержать менее ${num(p.limit)} ${plural(p.limit, 'символа', 'символов')}`,
  maxLength: (p) => `не должно содержать более ${num(p.limit)} ${plural(p.limit, 'символа', 'символов')}`,
  pattern: 'должно соответствовать шаблону "{pattern}"',
  additionalProperties: (p) => p.additionalProperty
    ? `не должно содержать дополнительное свойство '${p.additionalProperty}'`
    : 'не должно содержать дополнительных свойств',
  minProperties: (p) => `не должно содержать менее ${num(p.limit)} ${plural(p.limit, 'свойства', 'свойств')}`,
  maxProperties: (p) => `не должно содержать более ${num(p.limit)} ${plural(p.limit, 'свойства', 'свойств')}`,
  minItems: (p) => `не должно содержать менее ${num(p.limit)} ${plural(p.limit, 'элемента', 'элементов')}`,
  maxItems: (p) => `не должно содержать более ${num(p.limit)} ${plural(p.limit, 'элемента', 'элементов')}`,
  uniqueItems: 'не должно содержать повторяющихся элементов',
  contains: 'должно содержать хотя бы один допустимый элемент',
  items: 'элементы списка недопустимы',
  allOf: 'должно соответствовать всем подсхемам',
  anyOf: 'должно соответствовать одной из подсхем в anyOf',
  oneOf: 'должно соответствовать ровно одной подсхеме в oneOf',
  not: 'НЕ должно соответствовать подсхеме',
  format: 'должно соответствовать формату "{format}"',
  if: 'должно соответствовать схеме "if"',
  then: 'должно соответствовать схеме "then"',
  else: 'должно соответствовать схеме "else"',
  'false schema': 'булева схема false всегда недопустима',
  $query: (p) => p.code
    ? `утверждение '$query' вызвало ${p.code} в '${p.docPath}'`
    : "должно удовлетворять утверждению '$query'",
  JQ2001: (p) => `утверждение '$query' не удалось вычислить (${p.code} в '${p.docPath}')`,
  JQ2003: (p) => `утверждение '$query' вернуло несколько результатов (${p.code} в '${p.docPath}')`,
  //#endregion

  //#region @jarenjs/forms (second-person field voice)
  'form/required': 'Это поле обязательно',
  'form/type': (p) => `Должно быть ${typeName(p.type)}`,
  'form/const': (p) => `Должно быть ${formatMessageValue(p.constValue)}`,
  'form/enum': (p) => `Должно быть ${Array.isArray(p.enumValues) ? listFormat.format(p.enumValues.map(formatMessageValue)) : formatMessageValue(p.enumValues)}`,
  'form/minLength': (p) => `Должно содержать не менее ${num(p.limit)} ${plural(p.limit, 'символа', 'символов')} (сейчас ${num(p.len)})`,
  'form/maxLength': (p) => `Должно содержать не более ${num(p.limit)} ${plural(p.limit, 'символа', 'символов')} (сейчас ${num(p.len)})`,
  'form/pattern': 'Должно соответствовать шаблону {pattern}',
  'form/format': (p) => `Должно соответствовать формату ${p.format}`,
  'form/minimum': (p) => `Должно быть не менее ${num(p.limit)}`,
  'form/maximum': (p) => `Должно быть не более ${num(p.limit)}`,
  'form/exclusiveMinimum': (p) => `Должно быть больше ${num(p.limit)}`,
  'form/exclusiveMaximum': (p) => `Должно быть меньше ${num(p.limit)}`,
  'form/multipleOf': (p) => `Должно быть кратно ${num(p.multipleOf)}`,
  'form/minItems': (p) => `Должно содержать не менее ${num(p.limit)} ${plural(p.limit, 'элемента', 'элементов')}`,
  'form/maxItems': (p) => `Должно содержать не более ${num(p.limit)} ${plural(p.limit, 'элемента', 'элементов')}`,
  'form/uniqueItems': 'Элементы должны быть уникальными',
  'form/minProperties': (p) => `Должно содержать не менее ${num(p.limit)} ${plural(p.limit, 'свойства', 'свойств')}`,
  'form/maxProperties': (p) => `Должно содержать не более ${num(p.limit)} ${plural(p.limit, 'свойства', 'свойств')}`,
  'x-form/assert': 'Недопустимое значение',
  'form/addItem': 'Добавить элемент',
  'form/removeItem': 'Удалить элемент',
  'form/jsonPlaceholder': 'Введите значение JSON',
  //#endregion

  //#region @jarenjs/contract (wire-error voice)
  'contract/not-found': 'ни одна операция не соответствует методу и пути запроса',
  'contract/method-not-allowed': 'путь обслуживается другими методами: {allow}',
  'contract/body-too-large': 'тело запроса операции {op} превышает её лимит в {limit} байт',
  'contract/unsupported-media': 'операция {op} принимает только тела {media}',
  'contract/malformed-json': 'тело запроса операции {op} не является корректным JSON',
  'contract/malformed-body': 'тело запроса операции {op} не является корректным текстом UTF-8',
  'contract/invalid-input': 'входные данные операции {op} недопустимы',
  'contract/idempotency-key-required': 'операция {op} требует заголовок Idempotency-Key',
  'contract/handler-failed': 'операция {op} завершилась с ошибкой',
  'contract/idempotency-conflict': 'Idempotency-Key операции {op} конфликтует с более ранним запросом ({kind})',
  'contract/invalid-output': 'операция {op} вернула ответ, нарушающий её контракт',
  'contract/malformed-path': 'путь запроса содержит некорректную процентную escape-последовательность или сегмент . либо ..',
  'contract/malformed-query': 'строка запроса не декодируется',
  'contract/not-implemented': 'операция {op} не реализована на этом сервере',
  'contract/precondition-failed': 'предусловие If-Match операции {op} не выполнено',
  'contract/invalid-header': 'заголовок {header} операции {op} недопустим',
  'contract/handler-error': 'операция {op} завершилась с ошибкой {code}',
  'contract/client-invalid-input': 'входные данные операции {op} недопустимы; ничего не было отправлено',
  'contract/network': 'запрос операции {op} не завершился ({name})',
  'contract/cancelled': 'запрос операции {op} был отменён',
  'contract/invalid-response': 'ответ операции {op} нарушает её контракт',
  'contract/key-storage-failed': 'ключ идемпотентности операции {op} не удалось сохранить; ничего не было отправлено',
  'contract/undeclared-response': 'операция {op} вернула незадекларированный ответ (статус {status})',
  'contract/not-a-contract': 'сервер не описывает контракт {id} по своему well-known-пути',
  'contract/incompatible': 'сервер использует версию {server} контракта {id}; этот клиент использует {client}, и ни одна сторона не объявляет другую совместимой',
  'contract/host-failed': 'операция {op} завершилась с ошибкой в хосте до получения результата',
  'contract/local-handler-failed': 'операция {op} завершилась с ошибкой в обслуживающем хосте',
  'contract/unknown-operation': 'запрос не называет ни одной операции, обслуживаемой на этом канале',
  'contract/port-timeout': 'операция {op} не получила ответа на канале за {ms} мс',
  'contract/malformed-frame': 'кадр ответа операции {op} некорректен',
  'contract/channel-closed': 'канал операции {op} закрыт',
  'contract/not-a-stream': 'сервер ответил на подписку операции {op} ответом, не являющимся потоком',
  'contract/invalid-snapshot': 'операция {op} вернула снимок, нарушающий её контракт',
  'contract/seq-regression': 'поток операции {op} нарушил порядок своих seq',
  'contract/stream-error': 'поток операции {op} завершился ошибкой сервера ({code})',
  'contract/heartbeat-missed': 'поток операции {op} молчал {ms} мс',
  'contract/slow-consumer': 'поток операции {op} завершён: потребитель отстал от своей ограниченной очереди',
  'contract/reconnect-exhausted': 'поток операции {op} не удалось восстановить после {attempts} попыток (последняя: {lastCode})',
  //#endregion

  //#region calendar language (the date names, relative phrasing and
  //   format display names of @jarenjs/locales' date adapter)
  // The month names are the FORMAT (genitive) forms, because the array
  // feeds a date pattern ('d MMMM yyyy' reads '27 июля 2026'), not a
  // standalone label. Both 'назад' and 'через' take the accusative, so
  // one set of counted forms serves past and future alike.
  ...dateNameEntries({
    months: [
      'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
      'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
    ],
    monthsShort: [
      'янв.', 'февр.', 'мар.', 'апр.', 'мая', 'июн.',
      'июл.', 'авг.', 'сент.', 'окт.', 'нояб.', 'дек.',
    ],
    weekdays: [
      'воскресенье', 'понедельник', 'вторник', 'среда',
      'четверг', 'пятница', 'суббота',
    ],
    weekdaysShort: [
      'вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб',
    ],
    meridiem: ['AM', 'PM'],
  }),
  'date/relative/second/past': (p) => `${num(p.value)} ${caseForms(p.value, { one: 'секунду', few: 'секунды', other: 'секунд' })} назад`,
  'date/relative/second/future': (p) => `через ${num(p.value)} ${caseForms(p.value, { one: 'секунду', few: 'секунды', other: 'секунд' })}`,
  'date/relative/minute/past': (p) => `${num(p.value)} ${caseForms(p.value, { one: 'минуту', few: 'минуты', other: 'минут' })} назад`,
  'date/relative/minute/future': (p) => `через ${num(p.value)} ${caseForms(p.value, { one: 'минуту', few: 'минуты', other: 'минут' })}`,
  'date/relative/hour/past': (p) => `${num(p.value)} ${caseForms(p.value, { one: 'час', few: 'часа', other: 'часов' })} назад`,
  'date/relative/hour/future': (p) => `через ${num(p.value)} ${caseForms(p.value, { one: 'час', few: 'часа', other: 'часов' })}`,
  'date/relative/day/past': (p) => `${num(p.value)} ${caseForms(p.value, { one: 'день', few: 'дня', other: 'дней' })} назад`,
  'date/relative/day/future': (p) => `через ${num(p.value)} ${caseForms(p.value, { one: 'день', few: 'дня', other: 'дней' })}`,
  'date/relative/week/past': (p) => `${num(p.value)} ${caseForms(p.value, { one: 'неделю', few: 'недели', other: 'недель' })} назад`,
  'date/relative/week/future': (p) => `через ${num(p.value)} ${caseForms(p.value, { one: 'неделю', few: 'недели', other: 'недель' })}`,
  'date/relative/month/past': (p) => `${num(p.value)} ${caseForms(p.value, { one: 'месяц', few: 'месяца', other: 'месяцев' })} назад`,
  'date/relative/month/future': (p) => `через ${num(p.value)} ${caseForms(p.value, { one: 'месяц', few: 'месяца', other: 'месяцев' })}`,
  'date/relative/year/past': (p) => `${num(p.value)} ${caseForms(p.value, { one: 'год', few: 'года', other: 'лет' })} назад`,
  'date/relative/year/future': (p) => `через ${num(p.value)} ${caseForms(p.value, { one: 'год', few: 'года', other: 'лет' })}`,
  'date/relative/now': 'сейчас',
  'date/relative/yesterday': 'вчера',
  'date/relative/today': 'сегодня',
  'date/relative/tomorrow': 'завтра',
  'format/name/date': 'дата',
  'format/name/time': 'время',
  'format/name/date-time': 'дата и время',
  'format/name/iso-date': 'дата ISO',
  'format/name/iso-time': 'время ISO',
  'format/name/iso-date-time': 'дата и время ISO',
  //#endregion

  //#region @jarenjs/json query engine (diagnostic voice)
  'query/reason': '{reason}',
  'query/detail': '{detail}',
  'query/item/sequence': 'последовательность из {count} элементов',
  'query/item/empty': 'пустая последовательность',
  'query/item/null': 'null',
  'query/item/array': 'список (array)',
  'query/item/object': 'объект',
  'query/item/string': 'строка (string)',
  'query/item/number': 'число',
  'query/item/boolean': 'булево значение',
  'query/item/other': 'значение типа {type}',
  'query/mixed-keys': 'объект не может смешивать ключи с префиксом $ ($-prefixed) и обычные ключи',
  'query/unknown-operator': "неизвестный оператор '{key}'",
  'query/unknown-operator-suggest': "неизвестный оператор '{key}' (возможно, вы имели в виду '{suggestion}'?)",
  'query/unknown-operator-use': "неизвестный оператор '{key}' (используйте {use})",
  'query/unknown-operator-none': "неизвестный оператор '{key}' (в jaren-query нет оператора, который это делает)",
  'query/use/head-of-reverse': '$head от $reverse',
  'query/use/jsonpath-filter': 'фильтр JSONPath вида $[?(@.x > 1)] или $where в $for',
  'query/use/for-return': 'фразу $for с $return',
  'query/use/for-phrase': 'фразу $for',
  'query/use/sort-objects': '$sort (сортирует скалярные значения; объекты упорядочивайте через $for по отсортированному ключу)',
  'query/use/sort-scalars': '$sort (только скалярные значения)',
  'query/use/entries-get': '$entries, затем $get',
  'query/use/geo-parse-text': '$geo-parse для чтения, $geo-text для записи',
  'query/use/bbox-intersects': '$bbox-intersects (только ограничивающие прямоугольники — настоящий геометрический оверлей намеренно отсутствует)',
  'query/use/renderer': 'слой отрисовки карты — язык запросов вообще не может создавать проекционные координаты, так что измерение никогда не может на них опираться; измерения здесь геодезические',
  'query/use/renderer-project': "слой отрисовки карты, как и для '$project'",
  'query/use/similarity': '$similarity (чем выше значение, тем ближе; метрики расстояния нет)',
  'query/use/knn-desc': "$orderby по ключу $similarity с $dir 'desc', затем $subsequence для выбора k ближайших соседей",
  'query/use/knn': '$orderby по ключу $similarity, затем $subsequence',
  'query/use/top-k': '$orderby, затем $subsequence',
  'query/use/resample-fill': "$resample со свойством 'fill'",
  'query/use/resample-locf': "$resample с заполнением 'locf'",
  'query/use/resample-linear': "$resample с заполнением 'linear'",
  'query/use/rolling-mean': "$rolling с агрегатной функцией 'mean'",
  'query/use/trim': '$replace вокруг сигнального символа, по одному краю за раз (QUERY-FORMAT §8.7 показывает, как это сделать)',
  'query/use/truncate': '$idiv на 1, что даёт усечение к нулю; $floor и $ceiling округляют к минус и плюс бесконечности соответственно',
  'query/phrase-keys': 'недопустимое сочетание ключей фразы ({keys})',
  'query/phrase-alone': "'{key}' не может самостоятельно образовать фразу",
  'query/operands-array': "'{op}' принимает список выражений",
  'query/operands-exactly': "число операндов '{op}' должно быть ровно {min}, получено: {count}",
  'query/operands-at-least': "число операндов '{op}' должно быть не менее {min}, получено: {count}",
  'query/operands-range': "число операндов '{op}' должно быть от {min} до {max}, получено: {count}",
  'query/variable-name-expected': 'ожидалась строка с именем переменной',
  'query/variable-name-invalid': "'{name}' не является допустимым именем переменной",
  'query/variable-duplicate': "повторная привязка переменной '{name}' в пределах одной фразы",
  'query/bindings-object': "'{clause}' принимает объект привязок переменных",
  'query/bindings-empty': "'{clause}' требует хотя бы одной привязки",
  'query/extended-let': "расширенная форма привязки недоступна в '$let'",
  'query/extended-quantifier': 'расширенная форма привязки недоступна в кванторах',
  'query/window-kind': "значение '$window' должно быть 'tumbling' или 'sliding'",
  'query/window-size-required': "привязка '$window' требует '$size'",
  'query/window-size': "значение '$size' должно быть положительным целым числом",
  'query/window-step': "значение '$step' должно быть положительным целым числом",
  'query/window-required': "'$size'/'$step' требуют '$window'",
  'query/for-key': "'{key}' не является допустимым ключом расширенной привязки '$for'",
  'query/for-in-required': "расширенная привязка '$for' требует '$in'",
  'query/for-at': "'$at' принимает строку с именем переменной",
  'query/for-allowing-empty': "'$allowing-empty' принимает булево значение",
  'query/orderby-spec': "'$orderby' принимает спецификацию ключа или непустой список спецификаций ключей",
  'query/orderby-spec-key': "'{key}' не является допустимым ключом спецификации ключа $orderby",
  'query/orderby-spec-key-required': "явная спецификация ключа $orderby требует '$key'",
  'query/orderby-dir': "значение '$dir' должно быть 'asc' или 'desc'",
  'query/orderby-empty': "значение '$empty' должно быть 'least' или 'greatest'",
  'query/collation-name': "значение '$collation' должно быть именем зарегистрированного правила сортировки",
  'query/collation-unregistered': "'$collation' ссылается на незарегистрированное правило сортировки '{name}'",
  'query/fold-binding': "'$fold' принимает ровно одну привязку аккумулятора",
  'query/as-object': "'$as' принимает объект, свойства которого сопоставляют имена переменных со схемами",
  'query/as-empty': "'$as' требует хотя бы одного свойства",
  'query/as-unbound': "'$as' ссылается на переменную '{name}', которая не привязана в '$for'/'$let' этой фразы",
  'query/count-variable': "'$count' принимает строку с именем переменной",
  'query/map-entry': 'запись $map должна быть списком ровно из двух выражений',
  'query/call-arguments': "'$call' требует ['name', ...выражения аргументов]",
  'query/call-unregistered': "'$call' ссылается на незарегистрированную функцию '{name}'",
  'query/apply-arguments': "'$apply' принимает [селектор] или [селектор, режим]",
  'query/apply-mode': "режим '$apply' должен быть строковым литералом",
  'query/document-value': 'документ запроса не может содержать значение типа {type}',
  'query/invalid-path': "'{path}' не является допустимым путём или escape-последовательностью",
  'query/invalid-path-detail': "'{path}' не является допустимым путём: {detail}",
  'query/unbound-variable': "переменная '${name}' не привязана объемлющей фразой и не объявлена как внешний параметр (объявленные внешние параметры: {declared})",
  'query/unbound-variable-closed': "переменная '${name}' не привязана объемлющей фразой и не объявлена как внешний параметр (запрос скомпилирован в режиме замкнутого мира и не объявляет внешних параметров)",
  'query/version-unknown': 'неизвестная версия формата запроса {version}',
  'query/version-envelope': "конверт версии должен состоять ровно из ключей '$query' и '$expr'",
  'query/schema-no-compiler': 'операторам схем требуется компилятор проверок типа (options.compileTypeTest)',
  'query/schema-invalid': 'недопустимый литерал схемы: {detail}',
  'query/schema-no-predicate': 'компилятор проверок типа не вернул функцию-предикат',
  'query/depth-limit': 'глубина вложенности выражений в запросе ({depth}) превышает limits.depth ({limit})',
  'query/spec-member-required': "для '{name}' нужно свойство спецификации '{member}'",
  'query/spec-invalid': "спецификация '{name}': {detail}",
  'query/date-pattern': "шаблон '$date-format': {detail}",
  'query/time-bucket-invalid': "оператор '$time-bucket': {detail}",
  'query/lexical-arguments': '$lexical требует [провайдер, текстовое выражение, литеральный запрос]',
  'query/lexical-unregistered': "лексический провайдер '{name}' не зарегистрирован",
  'query/lexical-rejected': 'лексический провайдер отклонил запрос',
  'query/lexical-no-request': 'лексический провайдер не скомпилировал запрос',
  'query/series-spec-object': "'{operator}' принимает литеральный объект спецификации, получено: {got}",
  'query/series-spec-member': "у '{operator}' нет свойства спецификации '{name}'; допустимы: {allowed}",
  'query/series-spec-member-suggest': "у '{operator}' нет свойства спецификации '{name}' (возможно, вы имели в виду '{suggestion}'?); допустимы: {allowed}",
  'query/series-member-enum': "допустимые значения '{member}': {allowed}; получено: {got}",
  'query/series-member-number': "свойство '{member}' должно быть конечным числом, получено: {got}",
  'query/series-member-instant': "свойство '{member}' должно быть числом миллисекунд от начала эпохи или строкой RFC 3339, получено: {got}",
  'query/series-member-duration': "свойство '{member}' должно быть строкой длительности или числом миллисекунд, получено: {got}",
  'query/series-member-path': "свойство '{member}' должно быть одиночным путём внутри записи, получено: {got}",
  'query/series-member-path-detail': "свойство '{member}': {detail}",
  'query/series-member-not-path': "свойство '{member}' не является путём",
  'query/series-member-whole-row': "свойство '{member}' выбирает всю запись, а не её свойство",
  'query/series-member-singular': "свойство '{member}' должно быть одиночным путём — одно имя или индекс на сегмент, без подстановочных знаков, потомков и фильтров",
  'query/series-zone': "свойство 'zone' должно быть именем часового пояса IANA, получено: {got}",
  'query/series-zone-provider': "часовому поясу '{zone}' нужен провайдер часовых поясов: этот набор библиотек не включает tzdb, поэтому именованный пояс компилируется с помощью options.zoneProvider (toParts / toEpoch). 'UTC' и числовой 'offset' в провайдере не нуждаются",
  'query/series-calendar': 'календарный контекст: {detail}',
  'query/expected-string': 'ожидалась строка, получено: {got}',
  'query/expected-number': 'ожидалось число, получено: {got}',
  'query/cast-string': 'невозможно привести к строке: {got}',
  'query/cast-number': 'невозможно привести к числу: {got}',
  'query/not-json-number': "'{value}' не является числом JSON",
  'query/arithmetic-operand': 'арифметической операции нужен числовой операнд, получено: {got}',
  'query/round-precision': "точность '{op}' должна быть целым числом, получено: {got}",
  'query/format-picture': "шаблон '{picture}' для '$format-number' недопустим: {rule}",
  'query/picture/separator-twice': 'в нём больше одного разделителя подшаблонов',
  'query/picture/decimal-twice': 'в подшаблоне больше одного десятичного разделителя',
  'query/picture/percent': 'в подшаблоне больше одного знака процента или промилле',
  'query/picture/no-digit': 'в подшаблоне нет ни одной цифры — ни обязательной, ни необязательной',
  'query/picture/passive-inside': 'в подшаблоне пассивный символ стоит между активными',
  'query/picture/grouping-twice': 'в подшаблоне два разделителя групп разрядов стоят рядом',
  'query/picture/grouping-edge': 'разделитель групп разрядов стоит рядом с десятичным разделителем или завершает целую часть',
  'query/picture/digit-order': 'необязательная цифра следует за обязательной в целой части или предшествует обязательной в дробной части',
  'query/picture/exponent-twice': 'в подшаблоне больше одного разделителя экспоненты',
  'query/picture/exponent-percent': 'в подшаблоне одновременно есть экспонента и знак процента или промилле',
  'query/picture/exponent-digits': 'за разделителем экспоненты не следуют одни только цифры',
  'query/decimal-format-type': "'{op}' принимает запись десятичного формата или имя зарегистрированного формата, получено: {got}",
  'query/decimal-format-unknown': "'{op}' ссылается на незарегистрированный десятичный формат '{name}'",
  'query/decimal-format-invalid': "десятичный формат '{op}': {rule}",
  'query/decimal-format-record': 'десятичный формат — это объект с именованными символами',
  'query/decimal-format-member': "'{name}' не является свойством десятичного формата",
  'query/decimal-format-character': "значение '{name}' должно быть одним символом (для infinity и NaN — непустой строкой)",
  'query/decimal-format-zero': "zeroDigit '{char}' не является нулём семейства десятичных цифр",
  'query/decimal-format-clash': "символ '{char}' играет в шаблоне две роли",
  'query/quantity-unit': "'{op}' не знает единицы измерения '{unit}'",
  'query/aggregate-not-number': 'агрегируемые элементы должны быть числами, получено: {got}',
  'query/aggregate-null': 'агрегатная функция требует чисел или строк, получено: null',
  'query/minmax-mixed': "элементы '$min'/'$max' должны быть либо все числами, либо все строками, получено: {got}",
  'query/sort-mixed': "элементы '$sort' должны быть либо все числами, либо все строками, получено: {got}",
  'query/regex-invalid': "'{pattern}' не является допустимым шаблоном I-Regexp",
  'query/replace-empty-match': "шаблон '{pattern}' в '$replace' совпадает со строкой нулевой длины",
  'query/range-bounds': "границы '$range' должны быть безопасными целыми числами, получено: {got}",
  'query/range-guard': "число элементов '$range' ({count}) превышает защитный лимит ресурсов ({limit})",
  'query/index-of-item': "'$index-of' принимает один искомый элемент, получено: {got}",
  'query/expected-datetime': 'ожидалась строка даты, времени или даты и времени RFC 3339, получено: {got}',
  'query/no-date-component': "'{value}' не содержит компонента даты",
  'query/no-time-component': "'{value}' не содержит компонента времени",
  'query/calendar-unit': "ожидалась календарная единица ('year', 'month', 'day', ...), получено: {got}",
  'query/expected-duration': 'ожидалась длительность ISO 8601, получено: {got}',
  'query/expected-units': 'ожидалось количество единиц, получено: {got}',
  'query/expected-date-pattern': 'ожидался шаблон даты, получено: {got}',
  'query/date-names': "токену '{token}' в '$date-format' нужны названия месяцев или дней недели: скомпилируйте запрос с опцией dateNames (compileDateLocale(pack).names, из @jarenjs/locales)",
  'query/datetime-epoch': "'$datetime' принимает миллисекунды от начала эпохи, получено: {got}",
  'query/datetime-range': '{value} выходит за пределы диапазона, представимого в RFC 3339',
  'query/span-no-date': 'невозможно измерить промежуток от значения без даты',
  'query/expected-bucket-width': 'ожидалась ширина интервала группировки, получено: {got}',
  'query/expected-geo': 'ожидалось значение GeoJSON или позиция [долгота, широта], получено: {got}',
  'query/expected-wkt': 'ожидалась строка Well-Known Text, получено: {got}',
  'query/expected-geohash': 'ожидалась строка ячейки geohash, получено: {got}',
  'query/geohash-precision': 'точность geohash должна быть целым числом от 1 до 12, получено: {got}',
  'query/simplify-tolerance': 'допуск упрощения должен быть неотрицательным числом градусов, получено: {got}',
  'query/expected-vector': 'ожидался вектор (список чисел), получено: {got}',
  'query/expected-vector-item': 'ожидался вектор (список чисел), получено: {got} по индексу {index}',
  'query/expected-series': 'ожидался временной ряд (записи с моментом времени и показанием), получено: {got}',
  'query/expected-interval': 'ожидалась запись интервала {{ start, end }, получено: {got}',
  'query/member-cardinality': "свойство '{name}' вычислено в последовательность из {count} элементов; свойство объекта принимает ровно один элемент",
  'query/groupby-key': 'ключ $groupby должен быть пустой последовательностью или одним элементом, получено: {got}',
  'query/lexical-text': 'лексический текст должен быть одной строкой',
  'query/idiv-zero': "деление на ноль в '$idiv'",
  'query/mod-zero': "деление на ноль в '$mod'",
  'query/ebv-sequence': 'эффективное булево значение последовательности из двух и более элементов не определено',
  'query/map-key': 'ключ $map должен вычисляться в одну строку, получено: {got}',
  'query/orderby-key': 'ключ $orderby должен быть пустой последовательностью, числом или строкой, получено: {got}',
  'query/orderby-number-string': 'невозможно сравнить число со строкой в $orderby',
  'query/orderby-string-number': 'невозможно сравнить строку с числом в $orderby',
  'query/external-unbound': "внешний параметр '{name}' не привязан",
  'query/assert-failed': "проверка '$assert' не пройдена: {got} не удовлетворяет схеме",
  'query/assert-failed-item': "проверка '$assert' не пройдена: элемент {index} — {got} — не удовлетворяет схеме",
  'query/as-failed': "переменная '{name}' не прошла проверку по своей схеме '$as': {got} ей не удовлетворяет",
  'query/as-failed-item': "переменная '{name}' не прошла проверку по своей схеме '$as': элемент {index} — {got} — ей не удовлетворяет",
  'query/fold-limit': 'число элементов в аккумуляторе свёртки превысило {limit} (limits.sequenceItems)',
  'query/phrase-limit': 'фраза материализовала более {limit} элементов (limits.sequenceItems)',
  'query/steps-limit': 'запрос превысил limits.steps ({limit} вычислений выражений)',
  'query/result-limit': 'число элементов в результате запроса ({count}) превышает limits.resultItems ({limit})',
  'query/function-threw': "зарегистрированная функция '{name}' выбросила исключение: {detail}",
  'query/operator-threw': "зарегистрированный оператор '{name}' завершился с ошибкой: {detail}",
  'query/input-undefined': 'входной документ равен undefined, что не является значением JSON',
  'query/lexical-threw': 'лексический провайдер выбросил исключение',
  'query/lexical-result': 'лексический провайдер вернул недопустимый или неполный результат',
  //#endregion

  //#region @jarenjs/json formulas (the messages of formulaMessagesEn)
  'query/formula/query': '{formulaId}: {message}',
  'query/formula/detail': '{formulaId}: {detail}',
  'query/formula/profile-json': '{formulaId}: профиль должен быть в формате JSON',
  'query/formula/profile-object': '{formulaId}: профиль должен быть объектом',
  'query/formula/profile-version': '{formulaId}: неподдерживаемая версия языка',
  'query/formula/profile-identity': '{formulaId}: {member} не должно быть пустым и должно содержать не более 256 символов',
  'query/formula/profile-expression': '{formulaId}: выражение обязательно',
  'query/formula/profile-result-mode': '{formulaId}: неизвестный режим результата',
  'query/formula/profile-bindings': '{formulaId}: bindings должно быть объектом',
  'query/formula/profile-reserved': '{formulaId}: computed и context — зарезервированные привязки',
  'query/formula/profile-helpers': '{formulaId}: helpers должно быть массивом',
  'query/formula/profile-helper': '{formulaId}: у каждой вспомогательной функции должны быть уникальное имя и версия',
  'query/formula/profile-packs': '{formulaId}: packs должно быть массивом',
  'query/formula/profile-pack': '{formulaId}: у каждого пакета должны быть уникальное имя и версия',
  'query/formula/helper-missing': '{formulaId}: чистая вспомогательная функция {name}@{version} отсутствует или несовместима',
  'query/formula/pack-missing': '{formulaId}: пакет операторов {name}@{version} отсутствует или несовместим',
  'query/formula/helper-shadows': '{formulaId}: вспомогательная функция {name} носит имя функции из указанного пакета операторов',
  'query/formula/schema-missing': '{formulaId}: схема или компилятор проверок типа отсутствует или несовместим',
  'query/formula/schema-rejected': '{formulaId}: схема отклонена',
  'query/formula/computed-unnamed': '{formulaId}: ссылка на computed должна называть свою цель',
  'query/formula/computed-cycle': '{formulaId}: вычисляемые зависимости образуют цикл',
  'query/formula/computed-unknown': '{formulaId}: неизвестная вычисляемая цель',
  'query/formula/targets-invalid': '{formulaId}: недопустимый список целей',
  'query/formula/target-identity': '{formulaId}: у каждой цели должны быть уникальный идентификатор и логическое значение enabled',
  'query/formula/target-schemas': '{formulaId}: схемы цели должны быть объектом вида id -> {{version, schema}',
  'query/formula/target-schema-clash': "{formulaId}: две разные схемы под одним id '{id}'",
  'query/formula/batch-limit': '{formulaId}: превышен предел строк или ячеек пакетной обработки',
  'query/formula/row-identity': '{formulaId}: у каждой строки должен быть уникальный постоянный ID',
  'query/formula/input-schema': '{formulaId}: входные данные не соответствуют входной схеме',
  'query/formula/result-schema': '{formulaId}: результат не соответствует схеме результата',
  'query/formula/outcome-invalid': '{formulaId}: недопустимый помеченный результат',
  'query/formula/parity-expected': '{formulaId}: ожидаемый результат {index} не является JSON',
  'query/formula/rule-identity': '{formulaId}: правилу нужны идентификатор, цели и доступные для записи поля',
  'query/formula/rule-field-not-writable': '{formulaId}: целевое поле недоступно для записи',
  'query/formula/rule-rows': '{formulaId}: требуются ограниченный набор строк и ревизия набора данных',
  'query/formula/rule-entity-duplicate': '{formulaId}: повторяющийся идентификатор сущности',
  'query/formula/rule-preview-stale': '{formulaId}: предпросмотр устарел или изменён',
  'query/formula/rule-selection-duplicate': '{formulaId}: выбор должен содержать уникальные ID изменений',
  'query/formula/rule-selection-unknown': '{formulaId}: неизвестное выбранное изменение',
  'query/formula/rule-conflict': '{formulaId}: противоречащие друг другу значения для одного поля',
  //#endregion

  //#region @jarenjs/locales numbers (the decimal format, CLDR as ICU 78.3 ships it)
  'number/decimal-separator': ',',
  'number/grouping-separator': '\u00a0',
  'number/minus-sign': '-',
  'number/percent': '%',
  'number/per-mille': '‰',
  'number/zero-digit': '0',
  'number/exponent-separator': 'E',
  'number/infinity': '∞',
  'number/nan': 'не\u00a0число',
  'number/minimum-grouping-digits': '1',
  //#endregion
};
