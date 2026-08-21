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
 * `JQ2xxx` codes reachable through `$query`, and every `contract/*`
 * wire-error msgid of `@jarenjs/contract`'s `contractMessagesEn`.
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
  //#endregion

  //#region @jarenjs/contract (wire-error voice)
  'contract/not-found': 'nenhuma operação corresponde ao método e ao caminho da solicitação',
  'contract/method-not-allowed': 'o caminho é servido sob outros métodos: {allow}',
  'contract/body-too-large': 'o corpo da solicitação da operação {op} excede seu limite de {limit} bytes',
  'contract/unsupported-media': 'a operação {op} aceita apenas corpos {media}',
  'contract/malformed-json': 'o corpo da solicitação da operação {op} não é JSON válido',
  'contract/invalid-input': 'a entrada da operação {op} é inválida',
  'contract/idempotency-key-required': 'a operação {op} exige um cabeçalho Idempotency-Key',
  'contract/handler-failed': 'a operação {op} falhou',
  'contract/idempotency-conflict': 'a Idempotency-Key da operação {op} conflita com uma solicitação anterior ({kind})',
  'contract/invalid-output': 'a operação {op} produziu uma resposta que viola seu contrato',
  'contract/malformed-path': 'o caminho da solicitação contém um escape percentual malformado',
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
  //#endregion
};
