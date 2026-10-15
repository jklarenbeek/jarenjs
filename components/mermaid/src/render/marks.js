//@ts-check
/**
 * @file The identity markers every renderer writes: one contract for every
 * diagram type that draws something a reader can point at (MERMAID-FORMAT
 * §7). A node is a group with the `mm-node` class and `data-id`, its visible
 * name in the `mm-label` text inside it; an edge is an element with the
 * `mm-edge` class, `data-edge` (its position), `data-from` and `data-to`,
 * its label in an `mm-edge-label` text. An editor's event delegation and the
 * opt-in tooltips key on exactly these, whatever the type.
 *
 * A node a `click` statement gave tooltip text also carries it, as the
 * text of its first child `<desc>`: SVG's own description element, which
 * draws nothing, shows no native tooltip and names nothing, and whose text a
 * serializer escapes like any label's, so the author's text reaches the page
 * as text and the standalone SVG stays well-formed whatever it holds.
 *
 * This module is the renderers' shared vocabulary and imports nothing, so a
 * type's renderer reaches no other type's code through it.
 */

/**
 * The props of a node group.
 * @param {string} id the AST id, verbatim
 * @param {string} key the reconciliation key
 * @param {string | null} [classes] the type's own classes, after `mm-node`
 * @returns {Record<string, string>}
 */
export function nodeMark(id, key, classes = null) {
  return { class: classes === null ? 'mm-node' : `mm-node ${classes}`, key, 'data-id': id };
}

/**
 * A node group's children, led by the `<desc>` holding its tooltip text
 * when a `click` gave it one; the children unchanged otherwise.
 * @param {any[]} children
 * @param {string | undefined} tooltip
 * @returns {any[]}
 */
export function withTooltip(children, tooltip) {
  return tooltip === undefined || tooltip === '' ? children : [['desc', {}, tooltip], ...children];
}

/**
 * The props of an edge element.
 * @param {number} index its position among the type's edges
 * @param {string} from the id it leaves
 * @param {string} to the id it reaches
 * @param {string} key the reconciliation key
 * @param {string | null} [classes] the type's own classes, after `mm-edge`
 * @returns {Record<string, any>}
 */
export function edgeMark(index, from, to, key, classes = null) {
  return {
    class: classes === null ? 'mm-edge' : `mm-edge ${classes}`, key,
    'data-edge': index, 'data-from': from, 'data-to': to,
  };
}

/**
 * The tooltip text each id was given by the `click` statements: the last
 * one that names it with a tooltip wins, as in Mermaid.
 * @param {{ ids: string[], tooltip: string | null }[] | undefined} clicks
 *   a tree written before clicks were read has none
 * @returns {Map<string, string>}
 */
export function clickTooltips(clicks) {
  /** @type {Map<string, string>} */
  const tips = new Map();
  for (const click of clicks ?? []) {
    if (click.tooltip === null) continue;
    for (const id of click.ids) tips.set(id, click.tooltip);
  }
  return tips;
}
