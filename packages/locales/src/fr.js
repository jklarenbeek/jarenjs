//@ts-check

/**
 * French (fr) message catalog for @jarenjs/validate and @jarenjs/forms.
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
 * - `Intl.PluralRules` picks plural categories (French counts 0 and 1
 *   as singular: "0 caractère" / "2 caractères"),
 * - `Intl.NumberFormat` renders numeric limits the French way,
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

const pluralRules = new Intl.PluralRules('fr');
const numberFormat = new Intl.NumberFormat('fr-FR');
const listFormat = new Intl.ListFormat('fr', { style: 'long', type: 'disjunction' });

/** Pick the French singular or plural noun form for a count. */
const plural = makePluralPicker(pluralRules);

/**
 * Render a numeric limit through the French number format; non-numbers
 * (e.g. an unresolved $data pointer) render as-is.
 */
const num = makeNumberRenderer(numberFormat);

/** French names (with article) for the JSON Schema type keyword values. */
const TYPE_NAMES = {
  string: 'une chaîne (string)',
  number: 'un nombre',
  integer: 'un nombre entier',
  boolean: 'un booléen',
  array: 'une liste (array)',
  object: 'un objet',
  null: 'null',
};

/** Type keyword values under their French display name, article included. */
const typeName = makeTypeNamer(TYPE_NAMES);

//#endregion

/**
 * The French catalog. Covers every key of validate's `messagesEn`, every
 * `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, the
 * `JQ2xxx` codes reachable through `$query`, and every `contract/*`
 * wire-error msgid of `@jarenjs/contract`'s `contractMessagesEn`.
 * @type {Record<string, string | ((params: any, error?: object) => string)>}
 */
export const fr = {
  //#region @jarenjs/validate (document voice)
  type: (p) => p.types
    ? `doit être l'un des types suivants : ${p.types.join(', ')}`
    : `doit être ${typeName(p.type)}`,
  required: (p) => p.missingProperty
    ? `doit contenir la propriété obligatoire '${p.missingProperty}'`
    : 'doit contenir les propriétés obligatoires',
  minimum: (p) => `doit être ${p.comparison} ${num(p.limit)}`,
  maximum: (p) => `doit être ${p.comparison} ${num(p.limit)}`,
  exclusiveMinimum: (p) => `doit être ${p.comparison} ${num(p.limit)}`,
  exclusiveMaximum: (p) => `doit être ${p.comparison} ${num(p.limit)}`,
  multipleOf: (p) => `doit être un multiple de ${num(p.multipleOf)}`,
  minLength: (p) => `ne doit pas contenir moins de ${num(p.limit)} ${plural(p.limit, 'caractère', 'caractères')}`,
  maxLength: (p) => `ne doit pas contenir plus de ${num(p.limit)} ${plural(p.limit, 'caractère', 'caractères')}`,
  pattern: 'doit correspondre au motif "{pattern}"',
  additionalProperties: (p) => p.additionalProperty
    ? `ne doit pas contenir la propriété supplémentaire '${p.additionalProperty}'`
    : 'ne doit pas contenir de propriétés supplémentaires',
  minProperties: (p) => `ne doit pas contenir moins de ${num(p.limit)} ${plural(p.limit, 'propriété', 'propriétés')}`,
  maxProperties: (p) => `ne doit pas contenir plus de ${num(p.limit)} ${plural(p.limit, 'propriété', 'propriétés')}`,
  minItems: (p) => `ne doit pas contenir moins de ${num(p.limit)} ${plural(p.limit, 'élément', 'éléments')}`,
  maxItems: (p) => `ne doit pas contenir plus de ${num(p.limit)} ${plural(p.limit, 'élément', 'éléments')}`,
  uniqueItems: "ne doit pas contenir d'éléments en double",
  contains: 'doit contenir au moins un élément valide',
  items: 'les éléments de la liste sont invalides',
  allOf: 'doit satisfaire tous les sous-schémas',
  anyOf: 'doit satisfaire un sous-schéma de anyOf',
  oneOf: 'doit satisfaire exactement un sous-schéma de oneOf',
  not: 'ne doit PAS satisfaire le sous-schéma',
  format: 'doit correspondre au format "{format}"',
  if: 'doit satisfaire le schéma "if"',
  then: 'doit satisfaire le schéma "then"',
  else: 'doit satisfaire le schéma "else"',
  'false schema': 'le schéma booléen false est toujours invalide',
  $query: (p) => p.code
    ? `l'assertion '$query' a levé ${p.code} à '${p.docPath}'`
    : "doit satisfaire l'assertion '$query'",
  JQ2001: (p) => `l'assertion '$query' n'a pas pu être évaluée (${p.code} à '${p.docPath}')`,
  JQ2003: (p) => `l'assertion '$query' a produit plusieurs résultats (${p.code} à '${p.docPath}')`,
  //#endregion

  //#region @jarenjs/forms (second-person field voice)
  'form/required': 'Ce champ est obligatoire',
  'form/type': (p) => `Doit être ${typeName(p.type)}`,
  'form/const': (p) => `Doit être ${formatMessageValue(p.constValue)}`,
  'form/enum': (p) => `Doit être ${Array.isArray(p.enumValues) ? listFormat.format(p.enumValues.map(formatMessageValue)) : formatMessageValue(p.enumValues)}`,
  'form/minLength': (p) => `Doit contenir au moins ${num(p.limit)} ${plural(p.limit, 'caractère', 'caractères')} (actuellement ${num(p.len)})`,
  'form/maxLength': (p) => `Doit contenir au plus ${num(p.limit)} ${plural(p.limit, 'caractère', 'caractères')} (actuellement ${num(p.len)})`,
  'form/pattern': 'Doit correspondre au motif {pattern}',
  'form/format': (p) => `Doit respecter le format ${p.format}`,
  'form/minimum': (p) => `Doit être au moins ${num(p.limit)}`,
  'form/maximum': (p) => `Doit être au plus ${num(p.limit)}`,
  'form/exclusiveMinimum': (p) => `Doit être supérieur à ${num(p.limit)}`,
  'form/exclusiveMaximum': (p) => `Doit être inférieur à ${num(p.limit)}`,
  'form/multipleOf': (p) => `Doit être un multiple de ${num(p.multipleOf)}`,
  'form/minItems': (p) => `Doit contenir au moins ${num(p.limit)} ${plural(p.limit, 'élément', 'éléments')}`,
  'form/maxItems': (p) => `Doit contenir au plus ${num(p.limit)} ${plural(p.limit, 'élément', 'éléments')}`,
  'form/uniqueItems': 'Les éléments doivent être uniques',
  'form/minProperties': (p) => `Doit contenir au moins ${num(p.limit)} ${plural(p.limit, 'propriété', 'propriétés')}`,
  'form/maxProperties': (p) => `Doit contenir au plus ${num(p.limit)} ${plural(p.limit, 'propriété', 'propriétés')}`,
  'x-form/assert': 'Valeur invalide',
  'form/addItem': 'Ajouter un élément',
  "form/removeItem": "Supprimer l'élément",
  //#endregion

  //#region @jarenjs/contract (wire-error voice)
  'contract/not-found': 'aucune opération ne correspond à la méthode et au chemin de la requête',
  'contract/method-not-allowed': "le chemin est servi sous d'autres méthodes : {allow}",
  'contract/body-too-large': "le corps de la requête de l'opération {op} dépasse sa limite de {limit} octets",
  'contract/unsupported-media': "l'opération {op} n'accepte que des corps {media}",
  'contract/malformed-json': "le corps de la requête de l'opération {op} n'est pas du JSON valide",
  'contract/invalid-input': "l'entrée de l'opération {op} est invalide",
  'contract/idempotency-key-required': "l'opération {op} exige un en-tête Idempotency-Key",
  'contract/handler-failed': "l'opération {op} a échoué",
  'contract/idempotency-conflict': "la clé Idempotency-Key de l'opération {op} est en conflit avec une requête antérieure ({kind})",
  'contract/invalid-output': "l'opération {op} a produit une réponse qui viole son contrat",
  'contract/malformed-path': "le chemin de la requête contient une séquence d'échappement pour cent malformée",
  'contract/malformed-query': "la chaîne de requête n'est pas décodable",
  'contract/not-implemented': "l'opération {op} n'est pas implémentée sur ce serveur",
  'contract/precondition-failed': "la précondition If-Match de l'opération {op} a échoué",
  'contract/invalid-header': "l'en-tête {header} de l'opération {op} est invalide",
  'contract/handler-error': "l'opération {op} a échoué avec {code}",
  'contract/client-invalid-input': "l'entrée de l'opération {op} est invalide ; rien n'a été envoyé",
  'contract/network': "la requête de {op} ne s'est pas terminée ({name})",
  'contract/cancelled': "la requête de l'opération {op} a été annulée",
  'contract/invalid-response': "la réponse de l'opération {op} viole son contrat",
  'contract/key-storage-failed': "la clé d'idempotence de l'opération {op} n'a pas pu être enregistrée ; rien n'a été envoyé",
  'contract/undeclared-response': "l'opération {op} a renvoyé une réponse non déclarée (statut {status})",
  'contract/not-a-contract': 'le serveur ne décrit pas le contrat {id} à son chemin well-known',
  'contract/incompatible': "le serveur parle la version {server} du contrat {id} ; ce client parle {client} et aucune des deux extrémités ne déclare l'autre compatible",
  'contract/host-failed': "l'opération {op} a échoué dans l'hôte avant qu'un résultat ne soit produit",
  'contract/local-handler-failed': "l'opération {op} a échoué dans l'hôte qui la sert",
  'contract/unknown-operation': 'la requête ne nomme aucune opération servie sur ce canal',
  'contract/port-timeout': "l'opération {op} n'a reçu aucune réponse sur le canal en {ms} ms",
  'contract/malformed-frame': "la trame de réponse de l'opération {op} est malformée",
  'contract/channel-closed': "le canal de l'opération {op} est fermé",
  'contract/not-a-stream': "le serveur a répondu à l'abonnement de l'opération {op} par une réponse qui n'est pas un flux",
  'contract/invalid-snapshot': "l'opération {op} a produit un instantané qui viole son contrat",
  'contract/seq-regression': "le flux de l'opération {op} a violé l'ordre de ses seq",
  'contract/stream-error': "le flux de l'opération {op} s'est terminé par une erreur serveur ({code})",
  'contract/heartbeat-missed': "le flux de l'opération {op} est resté silencieux pendant {ms} ms",
  'contract/slow-consumer': "le flux de l'opération {op} s'est terminé : le consommateur a pris du retard sur sa file bornée",
  'contract/reconnect-exhausted': "le flux de l'opération {op} n'a pas pu être rétabli après {attempts} tentatives (dernière : {lastCode})",
  //#endregion

  //#region calendar language (the date names, relative phrasing and
  //   format display names of @jarenjs/locales' date adapter)
  // French keeps the singular at zero as well as at one, which is what
  // the pack's CLDR plural rules already say; 'mois' has no plural mark.
  ...dateNameEntries({
    months: [
      'janvier', 'février', 'mars', 'avril', 'mai', 'juin',
      'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre',
    ],
    monthsShort: [
      'janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin',
      'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.',
    ],
    weekdays: [
      'dimanche', 'lundi', 'mardi', 'mercredi',
      'jeudi', 'vendredi', 'samedi',
    ],
    weekdaysShort: [
      'dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.',
    ],
    meridiem: ['AM', 'PM'],
  }),
  'date/relative/second/past': (p) => `il y a ${num(p.value)} ${plural(p.value, 'seconde', 'secondes')}`,
  'date/relative/second/future': (p) => `dans ${num(p.value)} ${plural(p.value, 'seconde', 'secondes')}`,
  'date/relative/minute/past': (p) => `il y a ${num(p.value)} ${plural(p.value, 'minute', 'minutes')}`,
  'date/relative/minute/future': (p) => `dans ${num(p.value)} ${plural(p.value, 'minute', 'minutes')}`,
  'date/relative/hour/past': (p) => `il y a ${num(p.value)} ${plural(p.value, 'heure', 'heures')}`,
  'date/relative/hour/future': (p) => `dans ${num(p.value)} ${plural(p.value, 'heure', 'heures')}`,
  'date/relative/day/past': (p) => `il y a ${num(p.value)} ${plural(p.value, 'jour', 'jours')}`,
  'date/relative/day/future': (p) => `dans ${num(p.value)} ${plural(p.value, 'jour', 'jours')}`,
  'date/relative/week/past': (p) => `il y a ${num(p.value)} ${plural(p.value, 'semaine', 'semaines')}`,
  'date/relative/week/future': (p) => `dans ${num(p.value)} ${plural(p.value, 'semaine', 'semaines')}`,
  'date/relative/month/past': (p) => `il y a ${num(p.value)} ${plural(p.value, 'mois', 'mois')}`,
  'date/relative/month/future': (p) => `dans ${num(p.value)} ${plural(p.value, 'mois', 'mois')}`,
  'date/relative/year/past': (p) => `il y a ${num(p.value)} ${plural(p.value, 'an', 'ans')}`,
  'date/relative/year/future': (p) => `dans ${num(p.value)} ${plural(p.value, 'an', 'ans')}`,
  'date/relative/now': 'maintenant',
  'date/relative/yesterday': 'hier',
  'date/relative/today': 'aujourd\'hui',
  'date/relative/tomorrow': 'demain',
  'format/name/date': 'date',
  'format/name/time': 'heure',
  'format/name/date-time': 'date et heure',
  'format/name/iso-date': 'date ISO',
  'format/name/iso-time': 'heure ISO',
  'format/name/iso-date-time': 'date et heure ISO',
  //#endregion
};
