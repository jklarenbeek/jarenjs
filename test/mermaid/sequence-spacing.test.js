//@ts-check
/**
 * @file A sequence diagram's actors sit one gap apart, or further where the
 * text between them needs the room, as Mermaid widens an actor gap to its
 * messages: a message's text stays between the lifelines it spans, a
 * self-message's and a right-of note's text ends before the next lifeline
 * (or inside the diagram's width), and a left-of note on the first actor
 * starts inside the margin. Short text leaves every position as it was.
 */
import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';

import { textWidth } from '@jarenjs/view/helpers';
import { compileMermaid } from '@jarenjs/mermaid';

const layoutOf = (/** @type {string} */ source) => /** @type {any} */ (compileMermaid(source).toLayout());
const LONG = 'a message far longer than the gap two short actor boxes keep between them';
const width = (/** @type {string} */ text) => textWidth(text, 14);

describe('sequence layout — actors spaced to their text', () => {
  it('leaves short messages at one gap', () => {
    const { actors } = layoutOf('sequenceDiagram\n  A->>B: hi\n  B->>C: yo');
    assert.deepEqual(actors.map((/** @type {any} */ a) => a.boxX), [12, 152, 292]);
  });

  it('widens the lifelines a long message spans, and only those', () => {
    const { actors, messages } = layoutOf(`sequenceDiagram\n  participant A\n  participant B\n  participant C\n  A->>C: ${LONG}\n  B->>C: hi`);
    const [a, b, c] = actors;
    assert.ok(c.x - a.x >= width(LONG) + 20, `${c.x - a.x} spans ${width(LONG)}`);
    assert.equal(b.x - a.x, 140, 'A to B keeps one gap: no message lies only between them');
    assert.equal(messages[0].x2 - messages[0].x1, c.x - a.x);
  });

  it('gives a self-message and a right-of note room before the next lifeline and inside the width', () => {
    const self = layoutOf(`sequenceDiagram\n  A->>A: ${LONG}\n  A->>B: hi`);
    assert.ok(self.actors[1].x - self.actors[0].x >= 40 + 6 + width(LONG), 'the next lifeline');
    const last = layoutOf(`sequenceDiagram\n  A->>B: hi\n  note right of B: ${LONG}`);
    const note = last.notes[0];
    assert.ok(note.x + note.w <= last.width, `${note.x + note.w} inside ${last.width}`);
  });

  it('keeps a left-of note on the first actor inside the margin', () => {
    const { notes } = layoutOf(`sequenceDiagram\n  A->>B: hi\n  note left of A: ${LONG}`);
    assert.ok(notes[0].x >= 0, `${notes[0].x}`);
  });

  it('reads a message inside a block too', () => {
    const { actors } = layoutOf(`sequenceDiagram\n  A->>B: hi\n  loop each\n    A->>B: ${LONG}\n  end`);
    assert.ok(actors[1].x - actors[0].x >= width(LONG) + 20);
  });
});
