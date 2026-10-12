//@ts-check
/**
 * Diagram text is untrusted, and `A & B & … --> C & D & …` declares a link
 * for every pair: a source of fourteen kilobytes named a million edges, and
 * its rendering ran to hundreds of megabytes. A flowchart is refused past
 * ten thousand edges, with the line that crossed the bound; the render path
 * answers it with the error diagram like any other refusal.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { MermaidParseError, parseMermaid, renderMermaid } from '@jarenjs/mermaid';
import { renderToString } from '@jarenjs/view';

/** @param {number} from @param {number} to */
function fan(from, to) {
  const ids = (/** @type {string} */ p, /** @type {number} */ n) => Array.from({ length: n }, (_, i) => `${p}${i}`).join(' & ');
  return `flowchart TD\n${ids('A', from)} --> ${ids('B', to)}\n`;
}

describe('flowchart — the edges of one diagram are bounded', function () {
  it('accepts exactly ten thousand edges', () => {
    assert.equal(parseMermaid(fan(100, 100)).ast.edges.length, 10000);
  });

  it('refuses one edge more, on the line that crossed the bound', () => {
    assert.throws(() => parseMermaid(fan(100, 101)), (/** @type {any} */ e) =>
      e instanceof MermaidParseError && e.line === 2 && e.message === 'a flowchart holds at most 10000 edges');
  });

  it('counts the edges of earlier lines', () => {
    const rows = Array.from({ length: 100 }, (_, i) => `A${i} & B${i} & C${i} --> D${i} & E${i} & F${i} & G${i}`);
    assert.equal(parseMermaid(`flowchart TD\n${rows.join('\n')}\n`).ast.edges.length, 1200);
    const tail = rows.concat(Array.from({ length: 9 }, () => fan(100, 100).split('\n')[1]));
    assert.throws(() => parseMermaid(`flowchart TD\n${tail.join('\n')}\n`), { message: /at most 10000 edges/ });
  });

  it('refuses a million-edge source in a moment', () => {
    const started = performance.now();
    assert.throws(() => parseMermaid(fan(1000, 1000)), { message: /at most 10000 edges/ });
    assert.ok(performance.now() - started < 200);
  });

  it('renders the refusal as the error diagram', () => {
    const html = renderToString(renderMermaid(fan(1000, 1000)));
    assert.match(html, /at most 10000 edges/);
  });
});
