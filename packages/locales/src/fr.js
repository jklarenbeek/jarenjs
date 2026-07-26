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
 * `form/*` key of forms' `formsMessagesEn`, `x-form/assert`, and the
 * `JQ2xxx` codes reachable through `$query`.
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
};
