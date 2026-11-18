//@ts-check

/**
 * `patchIcal` inside VTODO, VJOURNAL and VALARM: `component` names a
 * VTODO or VJOURNAL by UID, `alarm` the nth VALARM of an event or VTODO.
 * Over every file of the reader's fixture corpus that holds one, each
 * edit changes only its own lines: every octet before and after them is
 * the input's, and the model the canonical read makes is the same.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parseIcal, patchIcal } from '@jarenjs/josl/ical';
import { createIntlZoneProvider } from '@jarenjs/locales/intl-zones';

const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));
const provider = createIntlZoneProvider({ revision: 'components' });
const LOSSLESS = /** @type {const} */ ({ mode: 'lossless', provider });

/** The corpus files that hold a VTODO, VJOURNAL or VALARM, as octets. */
function corpus() {
  /** @type {[string, Uint8Array][]} */
  const out = [];
  for (const dir of ['ical', 'ical-rfc']) {
    for (const name of fs.readdirSync(`${FIXTURES}${dir}`).filter((file) => file.endsWith('.ics')).sort()) {
      const bytes = new Uint8Array(fs.readFileSync(`${FIXTURES}${dir}/${name}`));
      if (/BEGIN:(VTODO|VJOURNAL|VALARM)/.test(new TextDecoder().decode(bytes)))
        out.push([`${dir}/${name}`, bytes]);
    }
  }
  return out;
}

/** @param {any} prop */
const unescaped = (prop) => prop.value.replace(/\\([\\,;nN])/g, (/** @type {string} */ _, /** @type {string} */ c) => (c === 'n' || c === 'N' ? '\n' : c));

/**
 * Where two octet strings differ: the first octet that differs and the
 * end of the differing span in the input.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
function changed(a, b) {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head])
    head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail])
    tail++;
  return [head, a.length - tail];
}

const decode = (/** @type {Uint8Array} */ bytes) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

/** The model of a read, without its provider. @param {Uint8Array} bytes */
const modelOf = (bytes) => JSON.stringify(parseIcal(bytes, { provider }).calendar);

describe('patchIcal: edits inside VTODO, VJOURNAL and VALARM, over the corpus', () => {
  const files = corpus();

  it('the corpus holds 11 such files: 4 VTODOs, 2 VJOURNALs, 7 VALARMs', () => {
    let todo = 0;
    let journal = 0;
    let alarms = 0;
    for (const [, bytes] of files) {
      const { tree } = /** @type {any} */ (parseIcal(bytes, LOSSLESS));
      for (const node of tree.root.children) {
        todo += node.name === 'VTODO' ? 1 : 0;
        journal += node.name === 'VJOURNAL' ? 1 : 0;
        alarms += node.children.filter((/** @type {any} */ child) => child.name === 'VALARM').length;
      }
    }
    assert.deepStrictEqual([files.length, todo, journal, alarms], [11, 4, 2, 7]);
  });

  for (const [name, bytes] of files) {
    it(`${name}: each edit's octets are its own lines; the rest and the model are as read`, () => {
      const { tree } = /** @type {any} */ (parseIcal(bytes, LOSSLESS));
      const model = modelOf(bytes);
      let edits = 0;
      /** @param {any[]} list @param {[number, number]} span - the input octets the edit may change */
      const check = (list, span) => {
        const out = /** @type {Uint8Array} */ (patchIcal(tree, list));
        const [head, end] = changed(bytes, out);
        const same = out.length === bytes.length && head === bytes.length;
        assert.ok(same || (head >= span[0] && end <= span[1]), `${JSON.stringify(list)}: changed [${head}, ${end}) outside [${span}]`);
        assert.strictEqual(modelOf(out), model, JSON.stringify(list));
        edits++;
        return out;
      };
      for (const node of tree.root.children) {
        const uid = node.props.find((/** @type {any} */ prop) => prop.name === 'UID');
        if (uid === undefined)
          continue;
        const component = node.name === 'VTODO' ? 'todo' : node.name === 'VJOURNAL' ? 'journal' : node.name === 'VEVENT' ? 'event' : undefined;
        if (component === undefined)
          continue;
        const idProp = node.props.find((/** @type {any} */ prop) => prop.name === 'RECURRENCE-ID');
        const recurrenceId = idProp === undefined ? undefined : idProp.value.replace(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?(Z?)$/,
          (/** @type {string[]} */ ...m) => (m[4] === undefined ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}`));
        const at = { uid: unescaped(uid), ...(recurrenceId === undefined ? {} : { recurrenceId }), ...(component === 'event' ? {} : { component }) };
        if (component !== 'event') {
          const summary = node.props.find((/** @type {any} */ prop) => prop.name === 'SUMMARY');
          const text = decode(check([{ op: 'retitle', ...at, summary: 'Neu; erneut' }], summary === undefined ? [node.head, node.tail] : [summary.from, summary.to]));
          assert.ok(text.includes(String.raw`SUMMARY:Neu\; erneut`));
          const description = node.props.find((/** @type {any} */ prop) => prop.name === 'DESCRIPTION');
          check([{ op: 'describe', ...at, description: null }], description === undefined ? [node.head, node.head] : [description.from, description.to]);
          if (component === 'todo')
            check([{ op: 'relocate', ...at, location: 'Raum 2' }], [node.head, node.tail]);
          const removed = check([{ op: 'remove', ...at }], [node.from, node.to]);
          assert.strictEqual(removed.length, bytes.length - (node.to - node.from));
        }
        if (component === 'journal')
          continue;
        for (const [index, alarm] of node.children.filter((/** @type {any} */ child) => child.name === 'VALARM').entries()) {
          const trigger = alarm.props.find((/** @type {any} */ prop) => prop.name === 'TRIGGER');
          const absolute = /^\d{8}T/.test(trigger.value);
          if (absolute) {
            assert.throws(() => patchIcal(tree, [{ op: 'trigger', ...at, alarm: index, trigger: '-PT15M' }]), { code: 'ICAL4013', docPath: '/edits/0/trigger' });
          }
          else {
            const text = decode(check([{ op: 'trigger', ...at, alarm: index, trigger: '-PT20M' }], [trigger.from, trigger.to]));
            // its parameters (RELATED=END) are kept
            assert.ok(text.includes(`${trigger.params.length === 0 ? 'TRIGGER' : `TRIGGER;${trigger.params.map((/** @type {any} */ p) => `${p.name}=${p.values.join(',')}`).join(';')}`}:-PT20M`));
          }
          check([{ op: 'describe', ...at, alarm: index, description: 'Bald' }], [alarm.head, alarm.tail]);
          const removed = check([{ op: 'remove', ...at, alarm: index }], [alarm.from, alarm.to]);
          assert.strictEqual(removed.length, bytes.length - (alarm.to - alarm.from));
        }
      }
      assert.ok(edits > 0);
    });
  }
});

describe('patchIcal: what an edit of a VTODO, VJOURNAL or VALARM refuses', () => {
  const text = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:p', 'BEGIN:VEVENT', 'UID:e', 'DTSTAMP:20260101T000000Z', 'DTSTART:20260302T090000Z',
    'BEGIN:VALARM', 'ACTION:DISPLAY', 'DESCRIPTION:Soon', 'TRIGGER:-PT5M', 'END:VALARM', 'END:VEVENT',
    'BEGIN:VTODO', 'UID:t', 'DTSTAMP:20260101T000000Z', 'SUMMARY:Do', 'END:VTODO',
    'BEGIN:VJOURNAL', 'UID:j', 'DTSTAMP:20260101T000000Z', 'END:VJOURNAL', 'END:VCALENDAR', ''].join('\r\n');
  const { tree } = /** @type {any} */ (parseIcal(text, LOSSLESS));
  const refuses = (/** @type {any[]} */ edits, /** @type {string} */ code, /** @type {string} */ docPath) =>
    assert.throws(() => patchIcal(tree, edits), { code, docPath });

  it('a component, alarm or trigger of the wrong shape, and an edit the component does not take (ICAL4001)', () => {
    refuses([{ op: 'retitle', uid: 't', component: 'task', summary: 'x' }], 'ICAL4001', '/edits/0/component');
    refuses([{ op: 'cancel', uid: 't', component: 'todo' }], 'ICAL4001', '/edits/0/component');
    refuses([{ op: 'relocate', uid: 'j', component: 'journal', location: 'x' }], 'ICAL4001', '/edits/0/op');
    refuses([{ op: 'trigger', uid: 'e', trigger: '-PT1M' }], 'ICAL4001', '/edits/0/op');
    refuses([{ op: 'describe', uid: 'j', component: 'journal', alarm: 0, description: 'x' }], 'ICAL4001', '/edits/0/alarm');
    refuses([{ op: 'retitle', uid: 'e', alarm: 0, summary: 'x' }], 'ICAL4001', '/edits/0/alarm');
    refuses([{ op: 'describe', uid: 'e', alarm: -1, description: 'x' }], 'ICAL4001', '/edits/0/alarm');
    refuses([{ op: 'describe', uid: 'e', alarm: 0, description: null }], 'ICAL4001', '/edits/0/description');
    refuses([{ op: 'trigger', uid: 'e', alarm: 0, trigger: 'soon' }], 'ICAL3003', '/edits/0/trigger');
    refuses([{ op: 'trigger', uid: 'e', alarm: 0, trigger: '-+PT15M' }], 'ICAL3003', '/edits/0/trigger');
  });

  it('a VTODO, VJOURNAL or VALARM the file does not hold (ICAL4002), and two edits of one line (ICAL4010)', () => {
    refuses([{ op: 'retitle', uid: 'e', component: 'todo', summary: 'x' }], 'ICAL4002', '/edits/0/uid');
    refuses([{ op: 'remove', uid: 't', component: 'todo', recurrenceId: '2026-03-02' }], 'ICAL4002', '/edits/0/recurrenceId');
    refuses([{ op: 'remove', uid: 'e', alarm: 1 }], 'ICAL4002', '/edits/0/alarm');
    refuses([{ op: 'trigger', uid: 'e', alarm: 0, trigger: '-PT1M' }, { op: 'trigger', uid: 'e', alarm: 0, trigger: '-PT2M' }], 'ICAL4010', '/edits/1');
    refuses([{ op: 'remove', uid: 'e', alarm: 0 }, { op: 'describe', uid: 'e', alarm: 0, description: 'x' }], 'ICAL4010', '/edits/1');
    refuses([{ op: 'remove', uid: 'e' }, { op: 'remove', uid: 'e', alarm: 0 }], 'ICAL4010', '/edits/1');
  });

  it('a VTODO and a VEVENT of one UID are edited apart', () => {
    const both = text.replace('UID:t', 'UID:e');
    const { tree: shared } = /** @type {any} */ (parseIcal(both, LOSSLESS));
    const out = /** @type {string} */ (patchIcal(shared, [{ op: 'retitle', uid: 'e', summary: 'Event' }, { op: 'retitle', uid: 'e', component: 'todo', summary: 'Todo' }]));
    assert.ok(out.includes('DTSTART:20260302T090000Z\r\nSUMMARY:Event\r\nBEGIN:VALARM') && out.includes('SUMMARY:Todo\r\nEND:VTODO'));
  });
});
