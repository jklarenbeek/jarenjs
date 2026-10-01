//@ts-check

/**
 * Portuguese (pt) message catalog for @jarenjs/validate and @jarenjs/forms.
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
 * - `Intl.PluralRules` picks plural categories, and "item" pluralizes
 *   irregularly ("1 item" / "2 itens"),
 * - `Intl.NumberFormat` renders numeric limits the Portuguese way,
 * - `Intl.ListFormat` renders enum alternatives ("a, b ou c"),
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

const pluralRules = new Intl.PluralRules('pt');
const numberFormat = new Intl.NumberFormat('pt');
const listFormat = new Intl.ListFormat('pt', { style: 'long', type: 'disjunction' });

/** Pick the Portuguese singular or plural noun form for a count. */
const plural = makePluralPicker(pluralRules);

/**
 * Render a numeric limit through the Portuguese number format;
 * non-numbers (e.g. an unresolved $data pointer) render as-is.
 */
const num = makeNumberRenderer(numberFormat);

/** Portuguese names (with article) for the JSON Schema type keyword values. */
const TYPE_NAMES = {
  string: 'um texto (string)',
  number: 'um número',
  integer: 'um número inteiro',
  boolean: 'um booleano',
  array: 'uma lista (array)',
  object: 'um objeto',
  null: 'null',
};

/** Type keyword values under their Portuguese display name, article included. */
const typeName = makeTypeNamer(TYPE_NAMES);

//#endregion

/**
 * The Portuguese catalog. Covers every key of validate's `messagesEn`,
 * every `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, the
 * `JQ2xxx` codes reachable through `$query`, every `contract/*`
 * wire-error msgid of `@jarenjs/contract`'s `contractMessagesEn`, and
 * every `query/*` message of `@jarenjs/json`'s `queryMessagesEn`.
 * @type {Record<string, string | ((params: any, error?: object) => string)>}
 */
export const pt = {
  //#region @jarenjs/validate (document voice)
  type: (p) => p.types
    ? `deve ser um dos seguintes tipos: ${p.types.join(', ')}`
    : `deve ser ${typeName(p.type)}`,
  required: (p) => p.missingProperty
    ? `deve ter a propriedade obrigatória '${p.missingProperty}'`
    : 'deve ter as propriedades obrigatórias',
  minimum: (p) => `deve ser ${p.comparison} ${num(p.limit)}`,
  maximum: (p) => `deve ser ${p.comparison} ${num(p.limit)}`,
  exclusiveMinimum: (p) => `deve ser ${p.comparison} ${num(p.limit)}`,
  exclusiveMaximum: (p) => `deve ser ${p.comparison} ${num(p.limit)}`,
  multipleOf: (p) => `deve ser um múltiplo de ${num(p.multipleOf)}`,
  minLength: (p) => `não deve ter menos de ${num(p.limit)} ${plural(p.limit, 'caractere', 'caracteres')}`,
  maxLength: (p) => `não deve ter mais de ${num(p.limit)} ${plural(p.limit, 'caractere', 'caracteres')}`,
  pattern: 'deve corresponder ao padrão "{pattern}"',
  additionalProperties: (p) => p.additionalProperty
    ? `não deve ter a propriedade adicional '${p.additionalProperty}'`
    : 'não deve ter propriedades adicionais',
  minProperties: (p) => `não deve ter menos de ${num(p.limit)} ${plural(p.limit, 'propriedade', 'propriedades')}`,
  maxProperties: (p) => `não deve ter mais de ${num(p.limit)} ${plural(p.limit, 'propriedade', 'propriedades')}`,
  minItems: (p) => `não deve ter menos de ${num(p.limit)} ${plural(p.limit, 'item', 'itens')}`,
  maxItems: (p) => `não deve ter mais de ${num(p.limit)} ${plural(p.limit, 'item', 'itens')}`,
  uniqueItems: 'não deve ter itens duplicados',
  contains: 'deve conter pelo menos um item válido',
  items: 'os itens da lista são inválidos',
  allOf: 'deve corresponder a todos os subesquemas',
  anyOf: 'deve corresponder a um subesquema de anyOf',
  oneOf: 'deve corresponder a exatamente um subesquema de oneOf',
  not: 'NÃO deve corresponder ao subesquema',
  format: 'deve corresponder ao formato "{format}"',
  if: 'deve corresponder ao esquema "if"',
  then: 'deve corresponder ao esquema "then"',
  else: 'deve corresponder ao esquema "else"',
  'false schema': 'o esquema booleano false é sempre inválido',
  $query: (p) => p.code
    ? `a asserção '$query' gerou ${p.code} em '${p.docPath}'`
    : "deve satisfazer a asserção '$query'",
  JQ2001: (p) => `a asserção '$query' não pôde ser avaliada (${p.code} em '${p.docPath}')`,
  JQ2003: (p) => `a asserção '$query' gerou vários resultados (${p.code} em '${p.docPath}')`,
  //#endregion

  //#region @jarenjs/forms (second-person field voice)
  'form/required': 'Este campo é obrigatório',
  'form/type': (p) => `Deve ser ${typeName(p.type)}`,
  'form/const': (p) => `Deve ser ${formatMessageValue(p.constValue)}`,
  'form/enum': (p) => `Deve ser ${Array.isArray(p.enumValues) ? listFormat.format(p.enumValues.map(formatMessageValue)) : formatMessageValue(p.enumValues)}`,
  'form/minLength': (p) => `Deve ter pelo menos ${num(p.limit)} ${plural(p.limit, 'caractere', 'caracteres')} (atualmente ${num(p.len)})`,
  'form/maxLength': (p) => `Deve ter no máximo ${num(p.limit)} ${plural(p.limit, 'caractere', 'caracteres')} (atualmente ${num(p.len)})`,
  'form/pattern': 'Deve corresponder ao padrão {pattern}',
  'form/format': (p) => `Deve respeitar o formato ${p.format}`,
  'form/minimum': (p) => `Deve ser pelo menos ${num(p.limit)}`,
  'form/maximum': (p) => `Deve ser no máximo ${num(p.limit)}`,
  'form/exclusiveMinimum': (p) => `Deve ser maior que ${num(p.limit)}`,
  'form/exclusiveMaximum': (p) => `Deve ser menor que ${num(p.limit)}`,
  'form/multipleOf': (p) => `Deve ser um múltiplo de ${num(p.multipleOf)}`,
  'form/minItems': (p) => `Deve ter pelo menos ${num(p.limit)} ${plural(p.limit, 'item', 'itens')}`,
  'form/maxItems': (p) => `Deve ter no máximo ${num(p.limit)} ${plural(p.limit, 'item', 'itens')}`,
  'form/uniqueItems': 'Os itens devem ser únicos',
  'form/minProperties': (p) => `Deve ter pelo menos ${num(p.limit)} ${plural(p.limit, 'propriedade', 'propriedades')}`,
  'form/maxProperties': (p) => `Deve ter no máximo ${num(p.limit)} ${plural(p.limit, 'propriedade', 'propriedades')}`,
  'x-form/assert': 'Valor inválido',
  'form/addItem': 'Adicionar item',
  'form/removeItem': 'Remover item',
  'form/jsonPlaceholder': 'Insira um valor JSON',
  //#endregion

  //#region @jarenjs/contract (wire-error voice)
  'contract/not-found': 'nenhuma operação corresponde ao método e ao caminho da solicitação',
  'contract/method-not-allowed': 'o caminho é servido sob outros métodos: {allow}',
  'contract/body-too-large': 'o corpo da solicitação da operação {op} excede seu limite de {limit} bytes',
  'contract/unsupported-media': 'a operação {op} aceita apenas corpos {media}',
  'contract/malformed-json': 'o corpo da solicitação da operação {op} não é JSON válido',
  'contract/malformed-body': 'o corpo da solicitação da operação {op} não é texto UTF-8 válido',
  'contract/invalid-input': 'a entrada da operação {op} é inválida',
  'contract/idempotency-key-required': 'a operação {op} exige um cabeçalho Idempotency-Key',
  'contract/handler-failed': 'a operação {op} falhou',
  'contract/idempotency-conflict': 'a Idempotency-Key da operação {op} conflita com uma solicitação anterior ({kind})',
  'contract/invalid-output': 'a operação {op} produziu uma resposta que viola seu contrato',
  'contract/malformed-path': 'o caminho da solicitação contém um escape percentual malformado, ou um segmento que é . ou ..',
  'contract/malformed-query': 'a cadeia de consulta não é decodificável',
  'contract/not-implemented': 'a operação {op} não está implementada neste servidor',
  'contract/precondition-failed': 'a pré-condição If-Match da operação {op} falhou',
  'contract/invalid-header': 'o cabeçalho {header} da operação {op} é inválido',
  'contract/handler-error': 'a operação {op} falhou com {code}',
  'contract/client-invalid-input': 'a entrada da operação {op} é inválida; nada foi enviado',
  'contract/network': 'a solicitação de {op} não foi concluída ({name})',
  'contract/cancelled': 'a solicitação da operação {op} foi cancelada',
  'contract/invalid-response': 'a resposta da operação {op} viola seu contrato',
  'contract/key-storage-failed': 'a chave de idempotência da operação {op} não pôde ser armazenada; nada foi enviado',
  'contract/undeclared-response': 'a operação {op} respondeu com uma resposta não declarada (status {status})',
  'contract/not-a-contract': 'o servidor não descreve o contrato {id} em seu caminho well-known',
  'contract/incompatible': 'o servidor fala a versão {server} do contrato {id}; este cliente fala {client} e nenhuma das extremidades declara a outra compatível',
  'contract/host-failed': 'a operação {op} falhou no host antes de um resultado ser produzido',
  'contract/local-handler-failed': 'a operação {op} falhou no host que a serve',
  'contract/unknown-operation': 'a solicitação não nomeia nenhuma operação servida neste canal',
  'contract/port-timeout': 'a operação {op} não obteve resposta no canal em {ms} ms',
  'contract/malformed-frame': 'o quadro de resposta da operação {op} está malformado',
  'contract/channel-closed': 'o canal da operação {op} está fechado',
  'contract/not-a-stream': 'o servidor respondeu à assinatura da operação {op} com uma resposta que não é um fluxo',
  'contract/invalid-snapshot': 'a operação {op} produziu um instantâneo que viola seu contrato',
  'contract/seq-regression': 'o fluxo da operação {op} violou a ordem de seus seq',
  'contract/stream-error': 'o fluxo da operação {op} terminou com um erro do servidor ({code})',
  'contract/heartbeat-missed': 'o fluxo da operação {op} ficou em silêncio por {ms} ms',
  'contract/slow-consumer': 'o fluxo da operação {op} terminou: o consumidor ficou atrás da sua fila limitada',
  'contract/reconnect-exhausted': 'o fluxo da operação {op} não pôde ser restabelecido após {attempts} tentativas (última: {lastCode})',
  //#endregion

  //#region calendar language (the date names, relative phrasing and
  //   format display names of @jarenjs/locales' date adapter)
  ...dateNameEntries({
    months: [
      'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
      'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro',
    ],
    monthsShort: [
      'jan.', 'fev.', 'mar.', 'abr.', 'mai.', 'jun.',
      'jul.', 'ago.', 'set.', 'out.', 'nov.', 'dez.',
    ],
    weekdays: [
      'domingo', 'segunda-feira', 'terça-feira', 'quarta-feira',
      'quinta-feira', 'sexta-feira', 'sábado',
    ],
    weekdaysShort: [
      'dom.', 'seg.', 'ter.', 'qua.', 'qui.', 'sex.', 'sáb.',
    ],
    meridiem: ['a.m.', 'p.m.'],
  }),
  'date/relative/second/past': (p) => `há ${num(p.value)} ${plural(p.value, 'segundo', 'segundos')}`,
  'date/relative/second/future': (p) => `dentro de ${num(p.value)} ${plural(p.value, 'segundo', 'segundos')}`,
  'date/relative/minute/past': (p) => `há ${num(p.value)} ${plural(p.value, 'minuto', 'minutos')}`,
  'date/relative/minute/future': (p) => `dentro de ${num(p.value)} ${plural(p.value, 'minuto', 'minutos')}`,
  'date/relative/hour/past': (p) => `há ${num(p.value)} ${plural(p.value, 'hora', 'horas')}`,
  'date/relative/hour/future': (p) => `dentro de ${num(p.value)} ${plural(p.value, 'hora', 'horas')}`,
  'date/relative/day/past': (p) => `há ${num(p.value)} ${plural(p.value, 'dia', 'dias')}`,
  'date/relative/day/future': (p) => `dentro de ${num(p.value)} ${plural(p.value, 'dia', 'dias')}`,
  'date/relative/week/past': (p) => `há ${num(p.value)} ${plural(p.value, 'semana', 'semanas')}`,
  'date/relative/week/future': (p) => `dentro de ${num(p.value)} ${plural(p.value, 'semana', 'semanas')}`,
  'date/relative/month/past': (p) => `há ${num(p.value)} ${plural(p.value, 'mês', 'meses')}`,
  'date/relative/month/future': (p) => `dentro de ${num(p.value)} ${plural(p.value, 'mês', 'meses')}`,
  'date/relative/year/past': (p) => `há ${num(p.value)} ${plural(p.value, 'ano', 'anos')}`,
  'date/relative/year/future': (p) => `dentro de ${num(p.value)} ${plural(p.value, 'ano', 'anos')}`,
  'date/relative/now': 'agora',
  'date/relative/yesterday': 'ontem',
  'date/relative/today': 'hoje',
  'date/relative/tomorrow': 'amanhã',
  'format/name/date': 'data',
  'format/name/time': 'hora',
  'format/name/date-time': 'data e hora',
  'format/name/iso-date': 'data ISO',
  'format/name/iso-time': 'hora ISO',
  'format/name/iso-date-time': 'data e hora ISO',
  //#endregion

  //#region @jarenjs/json query engine (diagnostic voice)
  'query/reason': '{reason}',
  'query/detail': '{detail}',
  'query/item/sequence': 'uma sequência de {count} itens',
  'query/item/empty': 'a sequência vazia',
  'query/item/null': 'null',
  'query/item/array': 'uma lista',
  'query/item/object': 'um objeto',
  'query/item/string': 'um texto',
  'query/item/number': 'um número',
  'query/item/boolean': 'um booleano',
  'query/item/other': 'um valor {type}',
  'query/mixed-keys': 'um objeto não pode misturar chaves $-prefixed e chaves simples',
  'query/unknown-operator': "operador desconhecido '{key}'",
  'query/unknown-operator-suggest': "operador desconhecido '{key}' (você quis dizer '{suggestion}'?)",
  'query/unknown-operator-use': "operador desconhecido '{key}' (use {use})",
  'query/unknown-operator-none': "operador desconhecido '{key}' (nenhum operador faz isso no jaren-query)",
  'query/use/head-of-reverse': '$head sobre $reverse',
  'query/use/jsonpath-filter': 'um filtro JSONPath como $[?(@.x > 1)] ou $where dentro de um $for',
  'query/use/for-return': 'uma frase $for com $return',
  'query/use/for-phrase': 'uma frase $for',
  'query/use/sort-objects': '$sort (ordena escalares; os objetos são ordenados com um $for sobre uma chave ordenada)',
  'query/use/sort-scalars': '$sort (apenas escalares)',
  'query/use/entries-get': '$entries e depois $get',
  'query/use/geo-parse-text': '$geo-parse para ler um, $geo-text para escrever um',
  'query/use/bbox-intersects': '$bbox-intersects (apenas caixas delimitadoras — a sobreposição real foi omitida deliberadamente)',
  'query/use/renderer': 'o renderizador do mapa — a linguagem não pode produzir nenhuma coordenada projetada, portanto uma medição nunca pode recair sobre uma; aqui a medição é geodésica',
  'query/use/renderer-project': "o renderizador do mapa, assim como para '$project'",
  'query/use/similarity': '$similarity (quanto maior, mais próximo; não há métrica de distância)',
  'query/use/knn-desc': "$orderby sobre uma chave $similarity com $dir 'desc' e depois $subsequence para os k primeiros",
  'query/use/knn': '$orderby sobre uma chave $similarity e depois $subsequence',
  'query/use/top-k': '$orderby e depois $subsequence',
  'query/use/resample-fill': "$resample com um 'fill'",
  'query/use/resample-locf': "$resample com fill 'locf'",
  'query/use/resample-linear': "$resample com fill 'linear'",
  'query/use/rolling-mean': "$rolling com aggregate 'mean'",
  'query/use/trim': '$replace em torno de um sentinela, uma ponta de cada vez (QUERY-FORMAT §8.7 detalha isso)',
  'query/use/truncate': '$idiv por 1, que trunca em direção a zero; $floor e $ceiling arredondam em direção a menos ou mais infinito',
  'query/phrase-keys': 'combinação inválida de chaves de frase ({keys})',
  'query/phrase-alone': "'{key}' não pode formar uma frase por si só",
  'query/operands-array': "'{op}' aceita uma lista de expressões",
  'query/operands-exactly': "'{op}' aceita exatamente {min} operando(s), recebeu {count}",
  'query/operands-at-least': "'{op}' aceita pelo menos {min} operando(s), recebeu {count}",
  'query/operands-range': "'{op}' aceita de {min} a {max} operando(s), recebeu {count}",
  'query/variable-name-expected': 'esperava-se um texto com um nome de variável',
  'query/variable-name-invalid': "'{name}' não é um nome de variável válido",
  'query/variable-duplicate': "vinculação duplicada da variável '{name}' dentro de uma mesma frase",
  'query/bindings-object': "'{clause}' aceita um objeto de vinculações de variáveis",
  'query/bindings-empty': "'{clause}' exige pelo menos uma vinculação",
  'query/extended-let': "a forma estendida de vinculação não está disponível em '$let'",
  'query/extended-quantifier': 'a forma estendida de vinculação não está disponível em quantificadores',
  'query/window-kind': "'$window' deve ser 'tumbling' ou 'sliding'",
  'query/window-size-required': "uma vinculação '$window' exige '$size'",
  'query/window-size': "'$size' deve ser um número inteiro positivo",
  'query/window-step': "'$step' deve ser um número inteiro positivo",
  'query/window-required': "'$size'/'$step' exigem '$window'",
  'query/for-key': "'{key}' não é uma chave válida de uma vinculação '$for' estendida",
  'query/for-in-required': "uma vinculação '$for' estendida exige '$in'",
  'query/for-at': "'$at' aceita um texto com um nome de variável",
  'query/for-allowing-empty': "'$allowing-empty' aceita um booleano",
  'query/orderby-spec': "'$orderby' aceita uma especificação de chave ou uma lista não vazia de especificações de chave",
  'query/orderby-spec-key': "'{key}' não é uma chave válida de uma especificação de chave de $orderby",
  'query/orderby-spec-key-required': "uma especificação de chave de $orderby explícita exige '$key'",
  'query/orderby-dir': "'$dir' deve ser 'asc' ou 'desc'",
  'query/orderby-empty': "'$empty' deve ser 'least' ou 'greatest'",
  'query/collation-name': "'$collation' deve ser o nome de uma ordenação registrada",
  'query/collation-unregistered': "'$collation' nomeia uma ordenação não registrada '{name}'",
  'query/fold-binding': "'$fold' aceita exatamente uma vinculação de acumulador",
  'query/as-object': "'$as' aceita um objeto cujos membros associam nomes de variável a esquemas",
  'query/as-empty': "'$as' exige pelo menos um membro",
  'query/as-unbound': "'$as' nomeia '{name}', que o '$for'/'$let' desta frase não vincula",
  'query/count-variable': "'$count' aceita um texto com um nome de variável",
  'query/map-entry': 'uma entrada de $map deve ser uma lista de exatamente duas expressões',
  'query/call-arguments': "'$call' exige ['name', ...expressões de argumento]",
  'query/call-unregistered': "'$call' nomeia uma função não registrada '{name}'",
  'query/apply-arguments': "'$apply' aceita [seletor] ou [seletor, modo]",
  'query/apply-mode': "o modo de '$apply' deve ser um texto literal",
  'query/document-value': 'um documento de consulta não pode conter um valor {type}',
  'query/invalid-path': "'{path}' não é um caminho nem um escape válido",
  'query/invalid-path-detail': "'{path}' não é um caminho válido: {detail}",
  'query/unbound-variable': "'${name}' não é uma variável vinculada por uma frase envolvente nem um parâmetro externo declarado (parâmetros externos declarados: {declared})",
  'query/unbound-variable-closed': "'${name}' não é uma variável vinculada por uma frase envolvente nem um parâmetro externo declarado (esta consulta foi compilada em modo de mundo fechado, sem declarar parâmetros externos)",
  'query/version-unknown': 'versão {version} desconhecida do formato de consulta',
  'query/version-envelope': "o envelope de versão exige exatamente as chaves '$query' e '$expr'",
  'query/schema-no-compiler': 'os operadores de esquema exigem um compilador de testes de tipo (options.compileTypeTest)',
  'query/schema-invalid': 'literal de esquema inválido: {detail}',
  'query/schema-no-predicate': 'o compilador de testes de tipo não retornou uma função predicado',
  'query/depth-limit': 'a consulta aninha expressões a {depth} níveis de profundidade, mais que limits.depth ({limit})',
  'query/spec-member-required': "'{name}' precisa de um membro de especificação '{member}'",
  'query/spec-invalid': "especificação de '{name}': {detail}",
  'query/date-pattern': "padrão de '$date-format': {detail}",
  'query/time-bucket-invalid': "'$time-bucket' inválido: {detail}",
  'query/lexical-arguments': '$lexical precisa de [provedor, expressão de texto, solicitação literal]',
  'query/lexical-unregistered': "o provedor léxico '{name}' não está registrado",
  'query/lexical-rejected': 'o provedor léxico rejeitou a solicitação',
  'query/lexical-no-request': 'o provedor léxico não compilou nenhuma solicitação',
  'query/series-spec-object': "'{operator}' aceita um objeto de especificação literal, obteve-se {got}",
  'query/series-spec-member': "'{operator}' não tem nenhum membro de especificação '{name}'; admite {allowed}",
  'query/series-spec-member-suggest': "'{operator}' não tem nenhum membro de especificação '{name}' (você quis dizer '{suggestion}'?); admite {allowed}",
  'query/series-member-enum': "'{member}' é um de {allowed}, obteve-se {got}",
  'query/series-member-number': "'{member}' é um número finito, obteve-se {got}",
  'query/series-member-instant': "'{member}' é uma quantidade de milissegundos desde a época ou um texto RFC 3339, obteve-se {got}",
  'query/series-member-duration': "'{member}' é um texto de duração ou uma quantidade de milissegundos, obteve-se {got}",
  'query/series-member-path': "'{member}' é um caminho singular dentro da linha, obteve-se {got}",
  'query/series-member-path-detail': "membro '{member}': {detail}",
  'query/series-member-not-path': "'{member}': não é um caminho",
  'query/series-member-whole-row': "'{member}' seleciona a linha inteira em vez de um de seus membros",
  'query/series-member-singular': "'{member}' é um caminho singular — um nome ou índice por segmento, sem curinga, descendente ou filtro",
  'query/series-zone': "'zone' é um nome de fuso horário IANA, obteve-se {got}",
  'query/series-zone-provider': "o fuso '{zone}' precisa de um provedor de fusos horários: esta suíte não inclui nenhuma tzdb, então um fuso nomeado é compilado com options.zoneProvider (toParts / toEpoch). 'UTC' e um 'offset' numérico não precisam de nenhum",
  'query/series-calendar': 'o contexto de calendário: {detail}',
  'query/expected-string': 'esperava-se um texto, obteve-se {got}',
  'query/expected-number': 'esperava-se um número, obteve-se {got}',
  'query/cast-string': 'não é possível converter {got} em texto',
  'query/cast-number': 'não é possível converter {got} em número',
  'query/not-json-number': "'{value}' não é um número JSON",
  'query/arithmetic-operand': 'a aritmética exige um operando numérico, obteve-se {got}',
  'query/round-precision': "a precisão de '{op}' deve ser um número inteiro, obteve-se {got}",
  'query/format-picture': "o padrão '{picture}' de '$format-number' é inválido: {rule}",
  'query/picture/separator-twice': 'tem mais de um separador de padrões',
  'query/picture/decimal-twice': 'um subpadrão tem mais de um separador decimal',
  'query/picture/percent': 'um subpadrão tem mais de um sinal de porcentagem ou de por mil',
  'query/picture/no-digit': 'um subpadrão não tem nenhum dígito obrigatório nem opcional',
  'query/picture/passive-inside': 'um subpadrão tem um caractere passivo entre caracteres ativos',
  'query/picture/grouping-twice': 'um subpadrão tem dois separadores de agrupamento adjacentes',
  'query/picture/grouping-edge': 'um separador de agrupamento fica junto ao separador decimal ou no fim da parte inteira',
  'query/picture/digit-order': 'um dígito opcional segue um obrigatório na parte inteira, ou precede um na parte fracionária',
  'query/picture/exponent-twice': 'um subpadrão tem mais de um separador de expoente',
  'query/picture/exponent-percent': 'um subpadrão tem ao mesmo tempo um expoente e um sinal de porcentagem ou de por mil',
  'query/picture/exponent-digits': 'um separador de expoente não é seguido apenas por dígitos',
  'query/decimal-format-type': "'{op}' aceita um registro de formato decimal ou o nome de um registrado, obteve-se {got}",
  'query/decimal-format-unknown': "'{op}' nomeia um formato decimal não registrado '{name}'",
  'query/decimal-format-invalid': "formato decimal de '{op}': {rule}",
  'query/decimal-format-record': 'um formato decimal é um objeto de caracteres nomeados',
  'query/decimal-format-member': "'{name}' não é um membro de um formato decimal",
  'query/decimal-format-character': "'{name}' deve ser um único caractere (infinity e NaN: um texto não vazio)",
  'query/decimal-format-zero': "zeroDigit '{char}' não é o zero de uma família de dígitos decimais",
  'query/decimal-format-clash': "'{char}' desempenha duas funções em um padrão",
  'query/quantity-unit': "'{op}' não conhece a unidade '{unit}'",
  'query/aggregate-not-number': 'os itens de um agregado devem ser números, obteve-se {got}',
  'query/aggregate-null': 'um agregado exige números ou textos, obteve-se null',
  'query/minmax-mixed': "os itens de '$min'/'$max' devem ser todos números ou todos textos, obteve-se {got}",
  'query/sort-mixed': "os itens de '$sort' devem ser todos números ou todos textos, obteve-se {got}",
  'query/regex-invalid': "'{pattern}' não é um padrão I-Regexp válido",
  'query/replace-empty-match': "o padrão '{pattern}' de '$replace' corresponde ao texto de comprimento zero",
  'query/range-bounds': "os limites de '$range' devem ser inteiros seguros, obteve-se {got}",
  'query/range-guard': "'$range' de {count} itens excede a salvaguarda de recursos de {limit} itens",
  'query/index-of-item': "'$index-of' aceita um único item de busca, obteve-se {got}",
  'query/expected-datetime': 'esperava-se um texto RFC 3339 de data, hora ou data e hora, obteve-se {got}',
  'query/no-date-component': "'{value}' não contém nenhum componente de data",
  'query/no-time-component': "'{value}' não contém nenhum componente de hora",
  'query/calendar-unit': "esperava-se uma unidade de calendário ('year', 'month', 'day', ...), obteve-se {got}",
  'query/expected-duration': 'esperava-se uma duração ISO 8601, obteve-se {got}',
  'query/expected-units': 'esperava-se um número de unidades, obteve-se {got}',
  'query/expected-date-pattern': 'esperava-se um padrão de data, obteve-se {got}',
  'query/date-names': "o especificador '{token}' de '$date-format' precisa de nomes de meses ou de dias da semana: compile com a opção dateNames (compileDateLocale(pack).names, de @jarenjs/locales)",
  'query/datetime-epoch': "'$datetime' aceita milissegundos desde a época, obteve-se {got}",
  'query/datetime-range': '{value} está fora do intervalo que o RFC 3339 consegue representar',
  'query/span-no-date': 'não é possível medir um lapso de tempo a partir de um valor sem data',
  'query/expected-bucket-width': 'esperava-se uma largura de balde, obteve-se {got}',
  'query/expected-geo': 'esperava-se um valor GeoJSON ou uma posição [longitude, latitude], obteve-se {got}',
  'query/expected-wkt': 'esperava-se um texto no formato Well-Known Text, obteve-se {got}',
  'query/expected-geohash': 'esperava-se um texto de célula geohash, obteve-se {got}',
  'query/geohash-precision': 'uma precisão geohash deve ser um número inteiro de 1 a 12, obteve-se {got}',
  'query/simplify-tolerance': 'uma tolerância de simplificação é um número não negativo de graus, obteve-se {got}',
  'query/expected-vector': 'esperava-se um vetor (uma lista de números), obteve-se {got}',
  'query/expected-vector-item': 'esperava-se um vetor (uma lista de números), obteve-se {got} no índice {index}',
  'query/expected-series': 'esperava-se uma série (registros com um instante e uma leitura), obteve-se {got}',
  'query/expected-interval': 'esperava-se um registro de intervalo {{ start, end }, obteve-se {got}',
  'query/member-cardinality': "o membro '{name}' produziu {count} itens; um membro de objeto aceita exatamente um",
  'query/groupby-key': 'uma chave de $groupby deve ser a sequência vazia ou um único item, obteve-se {got}',
  'query/lexical-text': 'o texto léxico deve ser um único valor de texto',
  'query/idiv-zero': "'$idiv' por zero",
  'query/mod-zero': "'$mod' por zero",
  'query/ebv-sequence': 'o valor booleano efetivo de uma sequência de dois ou mais itens é indefinido',
  'query/map-key': 'uma chave de $map deve produzir um único texto, obteve-se {got}',
  'query/orderby-key': 'uma chave de $orderby deve ser a sequência vazia, um número ou um texto, obteve-se {got}',
  'query/orderby-number-string': 'não é possível ordenar um número em relação a um texto em $orderby',
  'query/orderby-string-number': 'não é possível ordenar um texto em relação a um número em $orderby',
  'query/external-unbound': "o parâmetro externo '{name}' não foi vinculado",
  'query/assert-failed': "'$assert' falhou: {got} não satisfaz o esquema",
  'query/assert-failed-item': "'$assert' falhou: o item {index} ({got}) não satisfaz o esquema",
  'query/as-failed': "a variável '{name}' não passou no seu esquema '$as': {got} não o satisfaz",
  'query/as-failed-item': "a variável '{name}' não passou no seu esquema '$as': o item {index} ({got}) não o satisfaz",
  'query/fold-limit': 'um acumulador de dobra excedeu {limit} itens (limits.sequenceItems)',
  'query/phrase-limit': 'uma frase materializou mais de {limit} itens (limits.sequenceItems)',
  'query/steps-limit': 'a consulta excedeu limits.steps ({limit} avaliações de expressões)',
  'query/result-limit': 'o resultado da consulta tem {count} itens, mais que limits.resultItems ({limit})',
  'query/function-threw': "a função registrada '{name}' lançou uma exceção: {detail}",
  'query/operator-threw': "o operador registrado '{name}' falhou: {detail}",
  'query/input-undefined': 'o documento de entrada é undefined, o que não é um valor JSON',
  'query/lexical-threw': 'o provedor léxico lançou uma exceção',
  'query/lexical-result': 'o provedor léxico retornou um resultado inválido ou incompleto',
  //#endregion

  //#region @jarenjs/locales numbers (the decimal format, CLDR as ICU 78.3 ships it)
  'number/decimal-separator': ',',
  'number/grouping-separator': '.',
  'number/minus-sign': '-',
  'number/percent': '%',
  'number/per-mille': '‰',
  'number/zero-digit': '0',
  'number/exponent-separator': 'E',
  'number/infinity': '∞',
  'number/nan': 'NaN',
  //#endregion
};
