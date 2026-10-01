//@ts-check
/**
 * @file The property table (VIEW-FORMAT §3): what a prop name means to the
 * two renderers. The DOM patcher and the serializer both read it, so they
 * write the same attributes for every kind of property.
 *
 * **Enumerated attributes.** HTML spells a few on/off settings as
 * enumerated attributes with keywords of their own, and reflects four of
 * them (`spellcheck`, `draggable`, `translate`, `autocorrect`) through a
 * BOOLEAN IDL property. Any non-empty string assigned to such a property is
 * `true`, so `node.spellcheck = 'false'` turns spell-checking ON. Both
 * renderers therefore write these as attributes, always:
 *  - a JSON `true`/`false`, or the strings `'true'`/`'false'`, become the
 *    attribute's own keyword;
 *  - any other value is written as its string, and the browser applies the
 *    attribute's invalid-value default;
 *  - `null` and `undefined` omit the attribute.
 *
 * The keywords are the HTML Standard's (read 2026-10-01):
 *
 * | Attribute | true / false | Section |
 * |---|---|---|
 * | `contenteditable` | `true` / `false` (also `plaintext-only`) | §6.8.1, interaction.html#attr-contenteditable |
 * | `spellcheck` | `true` / `false` | §6.8.5, interaction.html#attr-spellcheck |
 * | `writingsuggestions` | `true` / `false` | §6.8.6, interaction.html#attr-writingsuggestions |
 * | `autocorrect` | `on` / `off` | §6.8.8, interaction.html#attr-autocorrect |
 * | `translate` | `yes` / `no` | §3.2.6.3, dom.html#attr-translate |
 * | `draggable` | `true` / `false` | §6.11.7, dnd.html#attr-draggable |
 *
 * `contentEditable` and `writingSuggestions`, the IDL spellings, are read as
 * the attributes they reflect. `autocapitalize`, `hidden` and `popover` are
 * enumerated too, but no JSON boolean names one of their keywords, so they
 * keep the ordinary rules.
 *
 * **Removal.** `null`, `false` or a removed prop on a property that is not
 * boolean removes the attribute the property reflects. Assigning `''`
 * instead throws for `size` (`IndexSizeError`), writes `width="0"`, leaves a
 * live `href=""` and makes a progress determinate. The serializer already
 * omits such a prop. A property with no attribute of its name
 * (`textContent`, `innerHTML`, `scrollTop`, …) is cleared to `''` as before,
 * and a property nothing was ever written to is left alone. **Boolean
 * properties** (`disabled`, `hidden`, `multiple`, …) are unchanged: `true`
 * sets them, `false` and `null` clear them.
 */

/**
 * An enumerated attribute: the name written, and the keywords a JSON
 * boolean stands for.
 * @typedef {{ readonly attribute: string, readonly yes: string, readonly no: string }} EnumeratedAttribute
 */

/** @param {string} attribute @param {string} yes @param {string} no
 * @returns {EnumeratedAttribute} */
const keywords = (attribute, yes, no) => Object.freeze({ attribute, yes, no });

/**
 * Every enumerated attribute whose keywords a JSON boolean names, by prop
 * name. A null-prototype record: a lookup never walks to `Object.prototype`.
 * @type {Readonly<Record<string, EnumeratedAttribute>>}
 */
export const ENUMERATED_ATTRIBUTES = Object.freeze(Object.assign(Object.create(null), {
  contenteditable: keywords('contenteditable', 'true', 'false'),
  contentEditable: keywords('contenteditable', 'true', 'false'),
  spellcheck: keywords('spellcheck', 'true', 'false'),
  writingsuggestions: keywords('writingsuggestions', 'true', 'false'),
  writingSuggestions: keywords('writingsuggestions', 'true', 'false'),
  autocorrect: keywords('autocorrect', 'on', 'off'),
  translate: keywords('translate', 'yes', 'no'),
  draggable: keywords('draggable', 'true', 'false'),
}));

/**
 * The attributes a props object can spell twice — the attribute's name and
 * its IDL property's — as pairs.
 * @type {ReadonlyArray<readonly [string, string]>}
 */
export const ENUMERATED_ALIASES = Object.freeze([
  Object.freeze(/** @type {const} */ (['contenteditable', 'contentEditable'])),
  Object.freeze(/** @type {const} */ (['writingsuggestions', 'writingSuggestions'])),
]);

/** The other spelling of an aliased prop, by prop name. */
const ALIAS_OF = Object.freeze(Object.assign(Object.create(null),
  Object.fromEntries(ENUMERATED_ALIASES.flatMap(([a, b]) => [[a, b], [b, a]]))));

/**
 * The other spelling of `name`'s attribute, or `undefined` for a prop no
 * other prop spells.
 * @param {string} name
 * @returns {string | undefined}
 */
export function aliasOf(name) {
  return ALIAS_OF[name];
}

/**
 * Whether a prop name is one of the aliased spellings. A length test first
 * (they are 15 and 18 characters long), so the prop a patch meets on every
 * element costs one compare.
 * @param {string} name
 * @returns {boolean}
 */
export function isAliased(name) {
  const n = name.length;
  return (n === 15 || n === 18) && ALIAS_OF[name] !== undefined;
}

/**
 * The spelling that writes an aliased attribute in `props`: of two, the
 * later in the object's own order — the DOM's last write wins, so the
 * serializer and the patcher take the same one — or `undefined` when
 * `props` spells it neither way.
 * @param {Record<string, any>} props
 * @param {string} a
 * @param {string} b
 * @returns {string | undefined}
 */
export function writingSpelling(props, a, b) {
  const hasA = a in props;
  const hasB = b in props;
  if (!hasA || !hasB) return hasA ? a : hasB ? b : undefined;
  for (const key in props) {
    if (key === a) return b;
    if (key === b) return a;
  }
  return b;
}

/**
 * The attribute an enumerated prop writes, and its value: `undefined` when
 * the prop is not an enumerated attribute, `{ name, value: null }` to omit
 * it, otherwise the keyword (or the value's own string).
 * @param {string} name - the prop name
 * @param {any} value - the prop value
 * @returns {{ name: string, value: string | null } | undefined}
 */
export function enumeratedAttribute(name, value) {
  const entry = ENUMERATED_ATTRIBUTES[name];
  if (entry === undefined) return undefined;
  if (value == null) return { name: entry.attribute, value: null };
  if (value === true || value === 'true') return { name: entry.attribute, value: entry.yes };
  if (value === false || value === 'false') return { name: entry.attribute, value: entry.no };
  return { name: entry.attribute, value: String(value) };
}

/**
 * The IDL properties whose content attribute has another name. Removing one
 * removes that attribute.
 * @type {Readonly<Record<string, string>>}
 */
const REFLECTED_ELSEWHERE = Object.freeze(Object.assign(Object.create(null), {
  className: 'class',
  htmlFor: 'for',
}));

/**
 * Remove a property the DOM renderer writes through the node (the removal
 * rule above): a boolean property is cleared, any other drops the
 * attribute it reflects, and one with no attribute of its name is cleared
 * to `''` when this renderer wrote it.
 * @param {any} node - an HTML element that has the property
 * @param {string} name - the property name
 * @param {any} oldValue - the value the previous frame wrote (`undefined`
 *   on a fresh node)
 */
export function removeProperty(node, name, oldValue) {
  if (typeof node[name] === 'boolean') {
    node[name] = false;
    return;
  }
  const attribute = REFLECTED_ELSEWHERE[name] ?? name;
  if (node.getAttribute(attribute) !== null) {
    node.removeAttribute(attribute);
    return;
  }
  if (oldValue != null && oldValue !== false) node[name] = '';
}
