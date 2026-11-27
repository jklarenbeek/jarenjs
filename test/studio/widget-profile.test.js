//@ts-check
/**
 * @file A studio widget a host grants under the interactive profile renders
 * its content under that profile: the renderer it builds takes the profile,
 * the grants and the id namespace from the widget context, so what a document
 * feeds it is never rendered trusted.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDomRenderer } from '@jarenjs/view';
import { createStudioDocumentHost } from '@jarenjs/studio/component';
import { createProjectDataRuntime } from '@jarenjs/studio/data';
import { createStubHost, fire } from '../view/dom.stub.js';

const walk = (node) => [node, ...(node.childNodes ?? []).flatMap(walk)];

describe('studio widgets under the interactive profile', () => {
  it('a document widget renders a host projection of document props under the profile', () => {
    // a host's markdown function that writes the source as HTML: trusted
    // rendering would hand it to innerHTML
    const studio = createStudioDocumentHost({
      markdown: (source) => ['div', { class: 'md', id: 'md', innerHTML: source }, ['a', { href: 'javascript:alert(1)' }, 'x'],
        ['button', { on: { click: { action: 'pick', with: source.length } } }, 'pick']],
      diagram: () => ['svg', {}],
    });
    const { document, container } = createStubHost();
    /** @type {string[]} */
    const seen = [];
    /** @type {any[]} */
    const events = [];
    const render = createDomRenderer(container, {
      document, safe: 'interactive', widgets: { markdown: studio.STUDIO_WIDGETS.markdown }, capabilities: { widgets: ['markdown'] },
      onUnsafe: (info) => seen.push(`${info.kind}:${info.name}`), onEvent: (binding, event) => events.push({ binding, event }),
    });
    render(['jaren-widget', { name: 'markdown', props: { source: '<img src=x onerror=alert(1)>' } }]);
    const content = walk(container).find((node) => node.getAttribute?.('class') === 'md');
    assert.ok(content, 'the widget rendered its content');
    assert.equal(content.attributes.has('innerHTML'), false);
    assert.equal(content.innerHTML, undefined);
    assert.equal(content.getAttribute('id'), 'jaren-u-md', 'the content joins the document\'s id namespace');
    assert.equal(content.childNodes[0].attributes.has('href'), false);
    assert.deepEqual(seen.sort(), ['prop:href', 'prop:innerHTML']);
    // the content's binding reaches the host as data, its event projected
    fire(content.childNodes[1], 'click', { view: globalThis });
    assert.deepEqual(events.map((e) => e.binding), [{ action: 'pick', with: 28 }]);
    assert.ok(Object.isFrozen(events[0].event));
    assert.equal('view' in events[0].event, false);
    // a later frame re-renders the content under the profile too
    render(['jaren-widget', { name: 'markdown', props: { source: 'two' } }]);
    assert.equal(walk(container).find((node) => node.getAttribute?.('class') === 'md').attributes.has('innerHTML'), false);
    render.destroy();
    assert.equal(container.childNodes.length, 0);
  });

  it('the project data widget renders its view under the profile, its draft still shown', () => {
    const runtime = createProjectDataRuntime();
    const { document, container } = createStubHost();
    const render = createDomRenderer(container, {
      document, safe: 'interactive', widgets: { data: runtime.widget }, capabilities: { widgets: ['data'] },
    });
    render(['jaren-widget', { name: 'data', props: { files: [], name: 'missing' } }]);
    const textarea = walk(container).find((node) => node.tagName === 'textarea');
    assert.ok(textarea, 'the widget drew');
    // under the profile the textarea is controlled: the draft is its live
    // value, it writes no `value` attribute (a parser ignores one), and the
    // widget's own text child still carries the draft
    assert.equal(textarea.getAttribute('value'), null);
    assert.equal(textarea.value, '{"id":"n1","title":"New note","points":20}');
    assert.equal(textarea.childNodes[0]?.nodeValue, '{"id":"n1","title":"New note","points":20}');
    // its own binding reads the typed text from the projection's target slice
    textarea.value = '{"id":"n2"}';
    assert.doesNotThrow(() => fire(textarea, 'input'));
    render(['jaren-widget', { name: 'data', props: { files: [], name: 'other' } }]);
    render.destroy();
    runtime.dispose();
  });
});
