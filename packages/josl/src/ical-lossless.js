//@ts-check

//#region loss-aware iCalendar editing
// `patchIcal` edits the syntax tree a lossless read keeps
// (`parseIcal(text, { mode: 'lossless' })`) and re-emits the input with
// the edits applied. The tree is a set of octet spans over the input, so
// the output is the input's own octets everywhere an edit does not reach:
// folding, line breaks (CRLF, bare LF), case, parameter quoting, X- and
// IANA properties, unknown components, VALARMs, VTIMEZONEs and the order
// of everything are as they were. An edit replaces, deletes or inserts
// whole content lines, and only its own:
//
// - a replaced line keeps its name and parameters as written and its
//   line break; only its value is new, folded at 75 octets;
// - an inserted line takes the line break of the line it follows, and is
//   placed after the last property of its component (an EXDATE after the
//   last EXDATE, an override after the last VEVENT of its UID);
// - a removed event takes exactly its own lines.
//
// An edit is checked against the model the same read produced: a slot
// must be one the series makes (asked of the calendar layer, never
// guessed), and an edit whose result the tree cannot hold without losing
// or contradicting content is refused with a code, before anything is
// emitted. RANGE=THISANDFUTURE overrides are kept as written and never
// expanded: an edit of their slot, or of a later one, is refused.
// Every edit reads the input as it was read: two edits that reach one
// line, one occurrence, or an event another removes are refused; read
// the output again to edit further. The output is read once more, under
// the options the tree was read with: an edit after which the canonical
// read would withhold an event it read before (a zoned override whose
// DURATION only the zone's offsets can place, say) is refused, so
// editing never takes an event out of the model.

import { CalendarError, defineSeries, expandSeries, parseTemporal } from '@jarenjs/core/calendar';
import { TREES, parseIcal, slotId, textOf } from './ical-read.js';
import { tzidParam } from './ical-vtimezone.js';
import { IcalError, daysOf, escapeText, foldLine, formatDate, formatFloating, formatUtc, instantOf, readDuration, wallOf }
  from './ical-wire.js';

const CR = 0x0D;
const LF = 0x0A;
const SP = 0x20;
const HTAB = 0x09;
const ID_FORM = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(Z)?)?$/;
const COMPACT_FORM = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/;
const TEXT_EDITS = /** @type {const} */ ({ retitle: ['SUMMARY', 'summary'], describe: ['DESCRIPTION', 'description'],
  relocate: ['LOCATION', 'location'] });
/** The members each edit takes, `op` and `uid` with them. */
const MEMBERS = Object.freeze({
  retitle: ['recurrenceId', 'summary'],
  describe: ['recurrenceId', 'description'],
  relocate: ['recurrenceId', 'location'],
  move: ['recurrenceId', 'start', 'end', 'duration', 'dtstamp'],
  cancel: ['recurrenceId'],
  exdate: ['recurrenceId'],
  remove: ['recurrenceId'],
});
/** What a new override does not copy from its series' VEVENT. */
const SERIES_ONLY = Object.freeze(['RRULE', 'RDATE', 'EXDATE', 'EXRULE']);

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

/**
 * One edit of a tree. Every edit names its event by `uid` (the model's,
 * escapes undone) and, for one occurrence of a series, its slot by
 * `recurrenceId`, spelled as an occurrence spells it (`2026-03-02`,
 * `2026-03-02T09:00:00`, `2026-03-02T08:00:00Z`).
 * - `retitle` / `describe` / `relocate`: set (`string`) or remove (`null`)
 *   SUMMARY, DESCRIPTION or LOCATION of the event, or of the occurrence's
 *   own VEVENT;
 * - `move`: give an occurrence a new `start` (and `end` or `duration`) of
 *   the series' kind; its own VEVENT is edited, or one is added, copied
 *   from the series' (DTSTAMP from `dtstamp` when given);
 * - `cancel`: STATUS:CANCELLED on the event, or on the occurrence's own
 *   VEVENT; an occurrence with none is excluded by an EXDATE;
 * - `exdate`: exclude an occurrence by an EXDATE on its series;
 * - `remove`: remove the event (every VEVENT of its UID), or only the
 *   occurrence's own VEVENT, which returns it to its series' form.
 * @typedef {{ op: 'retitle', uid: string, recurrenceId?: string, summary: string | null }
 *   | { op: 'describe', uid: string, recurrenceId?: string, description: string | null }
 *   | { op: 'relocate', uid: string, recurrenceId?: string, location: string | null }
 *   | { op: 'move', uid: string, recurrenceId: string, start: unknown, end?: unknown, duration?: string, dtstamp?: unknown }
 *   | { op: 'cancel', uid: string, recurrenceId?: string }
 *   | { op: 'exdate', uid: string, recurrenceId: string }
 *   | { op: 'remove', uid: string, recurrenceId?: string }} IcalEdit
 */

/**
 * @typedef {import('./ical-machine.js').IcalNode} Node
 * @typedef {import('./ical-machine.js').IcalProperty} Prop
 * @typedef {{ from: number, to: number, parts: Uint8Array[], order: number }} Change
 * @typedef {{ kind: 'date' | 'floating' | 'utc' | 'zoned', tzid: string | undefined, prop: Prop }} Shape
 * @typedef {{ masters: Node[], overrides: Map<string, Node[]>, last: number }} Group
 */

//#region the input's lines

/**
 * The line break that ends a span: CRLF, a bare LF, or none at the end of the input.
 * @param {Uint8Array} source
 * @param {{ from: number, to: number }} span
 * @returns {string}
 */
function endingOf(source, span) {
  const { to } = span;
  if (to - 1 >= span.from && source[to - 1] === LF)
    return to - 2 >= span.from && source[to - 2] === CR ? '\r\n' : '\n';
  return '';
}

/**
 * A property's unfolded line, as written: name, parameters and value in
 * their own case and quoting, no line break.
 * @param {Uint8Array} source
 * @param {Prop} prop
 * @returns {string}
 */
function unfoldedOf(source, prop) {
  const from = /** @type {number} */ (prop.from);
  const to = /** @type {number} */ (prop.to) - endingOf(source, /** @type {any} */ (prop)).length;
  const out = new Uint8Array(to - from);
  let n = 0;
  for (let i = from; i < to; i++) {
    const c = source[i];
    if (c === CR && source[i + 1] === LF && (source[i + 2] === SP || source[i + 2] === HTAB)) {
      i += 2;
      continue;
    }
    if (c === LF && (source[i + 1] === SP || source[i + 1] === HTAB)) {
      i += 1;
      continue;
    }
    out[n++] = c;
  }
  return decoder.decode(out.subarray(0, n));
}

/**
 * The parameters of a property as written, between its name and the
 * colon before its value: `;TZID="Europe/Amsterdam";X-A=b`.
 * @param {Uint8Array} source
 * @param {Prop} prop
 * @returns {{ name: string, params: string }}
 */
function spellingOf(source, prop) {
  const line = unfoldedOf(source, prop);
  return { name: line.slice(0, prop.name.length), params: line.slice(prop.name.length, line.length - prop.value.length - 1) };
}

/**
 * One content line, folded, ending in the line break given.
 * @param {string} line
 * @param {string} ending
 * @returns {string}
 */
function lineOf(line, ending) {
  const folded = foldLine(line);
  return ending === '\n' ? folded.replaceAll('\r\n', '\n') : folded;
}

/**
 * The properties of a component with one name.
 * @param {Node} node
 * @param {string} name
 * @returns {Prop[]}
 */
const named = (node, name) => node.props.filter((prop) => prop.name === name);

/**
 * The first value of a parameter, upper case for VALUE.
 * @param {Prop} prop
 * @param {string} name
 * @returns {string | undefined}
 */
function paramOf(prop, name) {
  const value = prop.params.find((param) => param.name === name)?.values[0];
  return name === 'VALUE' ? value?.toUpperCase() : value;
}

/**
 * The kind a DTSTART spells, with its TZID.
 * @param {Prop} prop
 * @returns {Shape}
 */
function shapeOf(prop) {
  const tzid = paramOf(prop, 'TZID');
  if (paramOf(prop, 'VALUE') === 'DATE')
    return { kind: 'date', tzid: undefined, prop };
  if (prop.value.endsWith('Z'))
    return { kind: 'utc', tzid: undefined, prop };
  return tzid === undefined ? { kind: 'floating', tzid, prop } : { kind: 'zoned', tzid, prop };
}

/**
 * The parameters a time of a series' kind is written with.
 * @param {Shape} shape
 * @returns {string}
 */
function timeParams(shape) {
  if (shape.kind === 'date')
    return ';VALUE=DATE';
  // a TZID read from the input holds no quote or control character: the reader refused those
  return shape.kind === 'zoned' ? `;TZID=${tzidParam(/** @type {string} */ (shape.tzid), '')}` : '';
}

/**
 * A slot's id as its RECURRENCE-ID spells it, or undefined.
 * @param {Prop} prop
 * @returns {string | undefined}
 */
function idOfProp(prop) {
  const form = COMPACT_FORM.exec(prop.value);
  if (form === null)
    return undefined;
  const date = `${form[1]}-${form[2]}-${form[3]}`;
  return form[4] === undefined ? date : `${date}T${form[4]}:${form[5]}:${form[6]}${form[7] ?? ''}`;
}

//#endregion

//#region the plan

/**
 * Refuse an edit.
 * @param {string} code
 * @param {string} reason
 * @param {string} at
 * @param {unknown} [cause]
 * @returns {never}
 */
function refuse(code, reason, at, cause = undefined) {
  throw new IcalError(code, reason, at, cause);
}

/** What the edits of one call are planned against. */
class Plan {
  /** @type {Change[]} */
  changes = [];
  /** @type {Map<string, { index: number, whole: boolean }>} */
  claims = new Map();
  /** @type {Map<string, Group>} */
  groups = new Map();
  /** @type {Map<string, Record<string, any>>} */
  model = new Map();
  #order = 0;

  /** @param {import('./ical-read.js').IcalTree} tree */
  constructor(tree) {
    this.tree = tree;
    this.source = tree.source;
    this.options = TREES.get(tree);
    for (const node of tree.root.children) {
      if (node.name !== 'VEVENT')
        continue;
      const uids = named(node, 'UID');
      if (uids.length !== 1)
        continue;
      let uid;
      try {
        uid = textOf(uids[0]);
      }
      catch {
        uid = uids[0].value;
      }
      let group = this.groups.get(uid);
      if (group === undefined) {
        group = { masters: [], overrides: new Map(), last: 0 };
        this.groups.set(uid, group);
      }
      group.last = Math.max(group.last, /** @type {number} */ (node.to));
      const ids = named(node, 'RECURRENCE-ID');
      if (ids.length === 0) {
        group.masters.push(node);
        continue;
      }
      const id = idOfProp(ids[0]) ?? ids[0].value;
      const list = group.overrides.get(id);
      if (list === undefined)
        group.overrides.set(id, [node]);
      else
        list.push(node);
    }
    for (const component of tree.calendar.components) {
      const uid = component.series?.uid ?? component.uid;
      if (typeof uid === 'string' && !this.model.has(uid))
        this.model.set(uid, component);
    }
  }

  /**
   * Claim what an edit reaches: its event, the component it writes in,
   * and the lines or occurrence it writes. A whole claim (a removal, a
   * line, a slot) shares its key with no other edit; a shared one (the
   * event or component an edit writes inside) with any but a whole one.
   * @param {Record<string, any>} edit
   * @param {number} index
   */
  claim(edit, index) {
    const claims = claimsOf(edit);
    for (const { key, whole } of claims) {
      const earlier = this.claims.get(key);
      if (earlier !== undefined && (earlier.whole || whole))
        refuse('ICAL4010', `edits ${earlier.index} and ${index} reach the same ${key.split('\u0000').slice(1).join(' ') || `event '${edit.uid}'`}`, `/edits/${index}`);
    }
    for (const { key, whole } of claims)
      this.claims.set(key, { index, whole: whole || this.claims.get(key)?.whole === true });
  }

  /**
   * Replace octets `[from, to)` with text or octets (an insertion when equal).
   * @param {number} from
   * @param {number} to
   * @param {string | Uint8Array[]} replacement - new text, or octets copied from the input and new text
   */
  change(from, to, replacement) {
    this.changes.push({ from, to, parts: typeof replacement === 'string' ? [encoder.encode(replacement)] : replacement, order: this.#order++ });
  }

  /**
   * The edited output.
   * @returns {Uint8Array}
   */
  emit() {
    const changes = this.changes.toSorted((a, b) => a.from - b.from || a.to - b.to || a.order - b.order);
    /** @type {Uint8Array[]} */
    const parts = [];
    let at = 0;
    for (const change of changes) {
      // edits are refused before two could reach one line: an overlap is a defect here
      if (change.from < at)
        throw new Error(`patchIcal planned two changes over the octets at ${change.from}`);
      parts.push(this.source.subarray(at, change.from), ...change.parts);
      at = change.to;
    }
    parts.push(this.source.subarray(at));
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let n = 0;
    for (const part of parts) {
      out.set(part, n);
      n += part.length;
    }
    return out;
  }
}

/**
 * The VEVENT an edit names: the event (no recurrenceId) or the
 * occurrence's own; `null` for an occurrence with none.
 * @param {Plan} plan
 * @param {Group} group
 * @param {string} uid
 * @param {string | undefined} id
 * @param {string} at
 * @returns {Node | null}
 */
function nodeOf(plan, group, uid, id, at) {
  const list = id === undefined ? group.masters : group.overrides.get(id) ?? [];
  if (list.length > 1)
    refuse('ICAL4003', `${list.length} VEVENTs hold the UID '${uid}'${id === undefined ? ' and no RECURRENCE-ID' : ` and the RECURRENCE-ID ${id}`}`, at);
  if (list.length === 0 && id === undefined)
    refuse('ICAL4002', `no VEVENT holds the UID '${uid}' without a RECURRENCE-ID`, at);
  return list[0] ?? null;
}

/**
 * The group of an edit's UID.
 * @param {Plan} plan
 * @param {Record<string, any>} edit
 * @param {string} at
 * @returns {Group}
 */
function groupOf(plan, edit, at) {
  const group = plan.groups.get(edit.uid);
  if (group === undefined)
    refuse('ICAL4002', `no VEVENT holds the UID '${edit.uid}'`, `${at}/uid`);
  return group;
}

/**
 * The series an occurrence edit reaches, checked: read by the canonical
 * read, of one series VEVENT, and not under a THISANDFUTURE override.
 * @param {Plan} plan
 * @param {Group} group
 * @param {Record<string, any>} edit
 * @param {string} at
 * @returns {{ series: any, master: Node, shape: Shape }}
 */
function seriesOf(plan, group, edit, at) {
  const { uid, recurrenceId: id } = edit;
  const master = nodeOf(plan, group, uid, undefined, at);
  const component = plan.model.get(uid);
  if (component === undefined)
    refuse('ICAL4006', `the read withheld the event '${uid}' (see its report), so the occurrence ${id} cannot be checked`, at);
  if (component.series === undefined)
    refuse('ICAL4004', `the event '${uid}' is not recurring; it has no occurrence ${id}`, `${at}/recurrenceId`);
  const { series } = component;
  for (const override of series.overrides) {
    if (override.range !== undefined && override.recurrenceId <= id) {
      refuse('ICAL4005', `the override of ${override.recurrenceId} ranges over this and future occurrences; it is kept as written and ${id} is not edited under it`,
        `${at}/recurrenceId`);
    }
  }
  const starts = named(master, 'DTSTART');
  return { series, master, shape: shapeOf(starts[0]) };
}

/**
 * Whether the series makes the slot: the calendar layer's answer, from a
 * probe series that cancels only it.
 * @param {Plan} plan
 * @param {any} series
 * @param {Shape} shape
 * @param {string} id
 * @param {string} at
 * @returns {boolean}
 */
function makes(plan, series, shape, id, at) {
  const form = ID_FORM.exec(id);
  const kind = form === null ? undefined : form[4] === undefined ? 'date' : form[7] === 'Z' ? 'utc' : 'floating';
  if (kind === undefined || (kind === 'floating' ? shape.kind !== 'floating' && shape.kind !== 'zoned' : kind !== shape.kind))
    return false;
  let probe;
  try {
    probe = defineSeries({ uid: series.uid, base: series.base, rdates: series.rdates, exdates: [],
      overrides: [{ recurrenceId: id, status: 'cancelled' }] });
  }
  catch (error) {
    if (error instanceof CalendarError)
      return false;
    throw error;
  }
  const near = shape.kind === 'utc' || shape.kind === 'zoned' ? [0, 1000]
    : [{ kind: 'date', date: '1970-01-01' }, { kind: 'date', date: '1970-01-02' }];
  let answer;
  try {
    answer = expandSeries(probe, { horizon: near, provider: plan.tree.zones.provider });
  }
  catch (error) {
    if (error instanceof CalendarError)
      refuse('ICAL4006', `the calendar layer cannot tell whether the series '${series.uid}' makes ${id}`, at, error);
    throw error;
  }
  if (answer.status !== 'complete')
    refuse('ICAL4006', `the calendar layer stopped at a limit before telling whether the series '${series.uid}' makes ${id}`, at);
  return !answer.orphans.ids.includes(id);
}

/**
 * Whether a slot is excluded or cancelled already.
 * @param {any} series
 * @param {string} id
 * @returns {boolean}
 */
const gone = (series, id) => series.exdates.some((/** @type {any} */ value) => slotId(value) === id)
  || series.overrides.some((/** @type {any} */ override) => override.recurrenceId === id && override.status === 'cancelled');

/**
 * A time of the series' kind, spelled: the value admitted by the
 * calendar layer, of the series' kind and zone, in whole seconds.
 * @param {unknown} value
 * @param {Shape} shape
 * @param {string} at
 * @returns {{ text: string, wall: number }}
 */
function timeOf(value, shape, at) {
  let admitted;
  try {
    admitted = /** @type {any} */ (parseTemporal(value));
  }
  catch (error) {
    if (error instanceof CalendarError)
      refuse('ICAL4001', `not a calendar value: ${error.message}`, at, error);
    throw error;
  }
  const zone = shape.kind === 'zoned' ? ` in ${shape.tzid}` : '';
  if (admitted.kind !== shape.kind || (shape.kind === 'zoned' && admitted.zone !== shape.tzid))
    refuse('ICAL4008', `the series is ${shape.kind}${zone}; the value is ${admitted.kind}${admitted.zone === undefined ? '' : ` in ${admitted.zone}`}`, at);
  if (admitted.kind === 'date') {
    const days = daysOf(admitted.date);
    return { text: formatDate(days), wall: days * 86400000 };
  }
  if (admitted.kind === 'utc') {
    const instant = instantOf(admitted.instant, at);
    return { text: formatUtc(instant), wall: instant };
  }
  const wall = wallOf(admitted.date, admitted.time, at);
  return { text: formatFloating(wall), wall };
}

/**
 * A slot's id in the series' compact spelling: `20260302T090000`.
 * @param {string} id
 * @returns {string}
 */
const compactOf = (id) => id.replace(/[-:]/g, '');

//#endregion

//#region the edits

/**
 * Set or remove one TEXT property of a component.
 * @param {Plan} plan
 * @param {Node} node
 * @param {string} name
 * @param {string | null} value
 * @param {string} at
 */
function setText(plan, node, name, value, at) {
  const existing = named(node, name);
  if (existing.length > 1)
    refuse('ICAL4007', `the component holds ${name} ${existing.length} times; which one to change is not known`, at);
  const prop = existing[0];
  if (prop !== undefined && prop.params.some((param) => param.name === 'ALTREP'))
    refuse('ICAL4007', `${name} has an alternate representation (ALTREP) the new text would leave stale`, at);
  if (value === null) {
    if (prop !== undefined)
      plan.change(/** @type {number} */ (prop.from), /** @type {number} */ (prop.to), '');
    return;
  }
  const text = escapeText(value, at);
  if (prop !== undefined) {
    replaceValue(plan, prop, text);
    return;
  }
  insertProperty(plan, node, `${name}:${text}`);
}

/**
 * Insert a property after the last property of a component.
 * @param {Plan} plan
 * @param {Node} node
 * @param {string} line - unfolded
 * @param {Prop} [after] - the property to follow instead
 */
function insertProperty(plan, node, line, after = node.props[node.props.length - 1]) {
  const at = /** @type {number} */ (after?.to ?? node.head);
  const ending = endingOf(plan.source, after === undefined ? { from: /** @type {number} */ (node.from), to: at } : /** @type {any} */ (after));
  plan.change(at, at, lineOf(line, ending || '\r\n'));
}

/**
 * Exclude a slot with an EXDATE after the series' last one (or its last property).
 * @param {Plan} plan
 * @param {Node} master
 * @param {Shape} shape
 * @param {string} id
 */
function addExdate(plan, master, shape, id) {
  const exdates = named(master, 'EXDATE');
  insertProperty(plan, master, `EXDATE${timeParams(shape)}:${compactOf(id)}`, exdates[exdates.length - 1]);
}

/**
 * The length of a moved occurrence: a DTEND or a DURATION, by name and value.
 * @param {Record<string, any>} edit
 * @param {Shape} shape
 * @param {number} wall - the new start's
 * @param {string} at
 * @returns {{ name: 'DTEND' | 'DURATION', value: string, line: string } | undefined} undefined when neither is given;
 *   `line` is the property spelled anew
 */
function lengthOf(edit, shape, wall, at) {
  if (edit.end !== undefined && edit.duration !== undefined)
    refuse('ICAL3007', 'a moved occurrence has an end or a duration, not both', at);
  if (edit.end !== undefined) {
    const end = timeOf(edit.end, shape, `${at}/end`);
    if (!(end.wall > wall))
      refuse('ICAL3007', 'a moved occurrence ends after it starts', `${at}/end`);
    return { name: 'DTEND', value: end.text, line: `DTEND${timeParams(shape)}:${end.text}` };
  }
  if (edit.duration !== undefined) {
    readDuration(edit.duration, `${at}/duration`);
    return { name: 'DURATION', value: edit.duration, line: `DURATION:${edit.duration}` };
  }
  return undefined;
}

/**
 * Move an occurrence: edit its own VEVENT, or add one after the last
 * VEVENT of its UID, copied from the series' VEVENT line by line. A time
 * property keeps its name and parameters as written (a series and its
 * overrides share one kind and zone), and only its value changes; a
 * DTEND that takes a DURATION's place, or the reverse, is spelled anew.
 * @param {Plan} plan
 * @param {Group} group
 * @param {Record<string, any>} edit
 * @param {string} at
 */
function move(plan, group, edit, at) {
  const { source } = plan;
  const { series, master, shape } = seriesOf(plan, group, edit, at);
  const id = edit.recurrenceId;
  const own = ownOf(plan, group, series, edit, at);
  const start = timeOf(edit.start, shape, `${at}/start`);
  const length = lengthOf(edit, shape, start.wall, at);
  const stamp = edit.dtstamp === undefined ? undefined : formatUtc(stampOf(edit.dtstamp, `${at}/dtstamp`));
  if (own !== null) {
    if (named(own, 'STATUS').some((prop) => prop.value.toUpperCase() === 'CANCELLED'))
      refuse('ICAL4004', `the occurrence ${id} is cancelled; it is not moved`, `${at}/recurrenceId`);
    if (length === undefined && named(own, 'DTEND').length !== 0)
      refuse('ICAL4009', `the occurrence ${id} ends at its DTEND; give the move an end or a duration`, at);
    const dtstart = named(own, 'DTSTART')[0];
    replaceValue(plan, dtstart, start.text);
    if (length !== undefined) {
      const same = named(own, length.name)[0];
      const other = named(own, length.name === 'DTEND' ? 'DURATION' : 'DTEND')[0];
      if (same !== undefined)
        replaceValue(plan, same, length.value);
      else if (other !== undefined)
        plan.change(/** @type {number} */ (other.from), /** @type {number} */ (other.to), lineOf(length.line, endingOf(source, /** @type {any} */ (other)) || '\r\n'));
      else
        insertProperty(plan, own, length.line, dtstart);
    }
    if (stamp !== undefined)
      setValue(plan, own, 'DTSTAMP', stamp, at);
    return;
  }
  if (gone(series, id) || !makes(plan, series, shape, id, at))
    refuse('ICAL4004', `the series '${edit.uid}' makes no occurrence ${id}${gone(series, id) ? ' that is not excluded or cancelled' : ''}`, `${at}/recurrenceId`);
  if (length === undefined && named(master, 'DTEND').length !== 0)
    refuse('ICAL4009', `the series ends each occurrence at its DTEND; give the move an end or a duration`, at);
  const ending = endingOf(source, /** @type {any} */ (shape.prop)) || '\r\n';
  // copied lines stay octets: an exporter may fold inside a UTF-8 sequence
  const raw = (/** @type {number | undefined} */ from, /** @type {number | undefined} */ to) => source.subarray(from, to);
  const line = (/** @type {string} */ text) => encoder.encode(lineOf(text, ending));
  const parts = [raw(master.from, master.head)];
  const lengthless = named(master, 'DTEND').length === 0 && named(master, 'DURATION').length === 0;
  let lengthWritten = false;
  for (const prop of master.props) {
    if (SERIES_ONLY.includes(prop.name))
      continue;
    if (prop.name === 'DTSTART') {
      parts.push(line(`RECURRENCE-ID${timeParams(shape)}:${compactOf(id)}`), line(respelled(source, prop, start.text)));
      if (length !== undefined && lengthless) {
        parts.push(line(length.line));
        lengthWritten = true;
      }
    }
    else if ((prop.name === 'DTEND' || prop.name === 'DURATION') && length !== undefined) {
      if (!lengthWritten)
        parts.push(line(prop.name === length.name ? respelled(source, prop, length.value) : length.line));
      lengthWritten = true;
    }
    else if (prop.name === 'DTSTAMP' && stamp !== undefined)
      parts.push(line(respelled(source, prop, stamp)));
    else
      parts.push(raw(prop.from, prop.to));
  }
  for (const child of master.children)
    parts.push(raw(child.from, child.to));
  parts.push(raw(master.tail, master.to));
  plan.change(group.last, group.last, parts);
}

/**
 * An occurrence's own VEVENT, when the file holds one: it must be one
 * the read took into the series, or its slot cannot be checked.
 * @param {Plan} plan
 * @param {Group} group
 * @param {any} series
 * @param {Record<string, any>} edit
 * @param {string} at
 * @returns {Node | null}
 */
function ownOf(plan, group, series, edit, at) {
  const own = nodeOf(plan, group, edit.uid, edit.recurrenceId, at);
  if (own !== null && !series.overrides.some((/** @type {any} */ override) => override.recurrenceId === edit.recurrenceId))
    refuse('ICAL4006', `the read withheld the VEVENT of the occurrence ${edit.recurrenceId} (see its report), so it cannot be checked`, at);
  return own;
}

/**
 * An instant for DTSTAMP: epoch milliseconds or a utc value.
 * @param {unknown} value
 * @param {string} at
 * @returns {number}
 */
function stampOf(value, at) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    return instantOf(value, at);
  let admitted;
  try {
    admitted = /** @type {any} */ (parseTemporal(value));
  }
  catch (error) {
    if (error instanceof CalendarError)
      refuse('ICAL4001', `dtstamp is epoch milliseconds or a utc value: ${error.message}`, at, error);
    throw error;
  }
  if (admitted.kind !== 'utc')
    refuse('ICAL4001', `dtstamp is epoch milliseconds or a utc value, not a ${admitted.kind} value`, at);
  return instantOf(admitted.instant, at);
}

/**
 * A property's line with a new value: its name and parameters as written.
 * @param {Uint8Array} source
 * @param {Prop} prop
 * @param {string} value - as written, escapes and all
 * @returns {string} unfolded
 */
function respelled(source, prop, value) {
  const spelled = spellingOf(source, prop);
  return `${spelled.name}${spelled.params}:${value}`;
}

/**
 * Replace one property's value, keeping its name, parameters and line break.
 * @param {Plan} plan
 * @param {Prop} prop
 * @param {string} value
 */
function replaceValue(plan, prop, value) {
  plan.change(/** @type {number} */ (prop.from), /** @type {number} */ (prop.to),
    lineOf(respelled(plan.source, prop, value), endingOf(plan.source, /** @type {any} */ (prop)) || '\r\n'));
}

/**
 * Set a property held at most once: its value replaced, or the property inserted.
 * @param {Plan} plan
 * @param {Node} node
 * @param {string} name
 * @param {string} value
 * @param {string} at - the edit, for a refusal
 */
function setValue(plan, node, name, value, at) {
  const existing = named(node, name);
  if (existing.length > 1)
    refuse('ICAL4007', `the component holds ${name} ${existing.length} times; which one to change is not known`, at);
  if (existing.length === 1)
    replaceValue(plan, existing[0], value);
  else
    insertProperty(plan, node, `${name}:${value}`);
}

/**
 * Cancel the event, or one occurrence.
 * @param {Plan} plan
 * @param {Group} group
 * @param {Record<string, any>} edit
 * @param {string} at
 */
function cancel(plan, group, edit, at) {
  const id = edit.recurrenceId;
  if (id === undefined) {
    const node = /** @type {Node} */ (nodeOf(plan, group, edit.uid, undefined, at));
    if (!named(node, 'STATUS').some((prop) => prop.value.toUpperCase() === 'CANCELLED'))
      setValue(plan, node, 'STATUS', 'CANCELLED', at);
    return;
  }
  const { series, master, shape } = seriesOf(plan, group, edit, at);
  const own = ownOf(plan, group, series, edit, at);
  if (own !== null) {
    if (!named(own, 'STATUS').some((prop) => prop.value.toUpperCase() === 'CANCELLED'))
      setValue(plan, own, 'STATUS', 'CANCELLED', at);
    return;
  }
  if (gone(series, id))
    return;
  if (!makes(plan, series, shape, id, at))
    refuse('ICAL4004', `the series '${edit.uid}' makes no occurrence ${id}`, `${at}/recurrenceId`);
  addExdate(plan, master, shape, id);
}

/**
 * Exclude one occurrence by an EXDATE.
 * @param {Plan} plan
 * @param {Group} group
 * @param {Record<string, any>} edit
 * @param {string} at
 */
function exdate(plan, group, edit, at) {
  const id = edit.recurrenceId;
  const { series, master, shape } = seriesOf(plan, group, edit, at);
  if (nodeOf(plan, group, edit.uid, id, at) !== null)
    refuse('ICAL4007', `the occurrence ${id} has its own VEVENT, which an EXDATE would leave behind; cancel or remove it`, `${at}/recurrenceId`);
  if (series.exdates.some((/** @type {any} */ value) => slotId(value) === id))
    return;
  if (!makes(plan, series, shape, id, at))
    refuse('ICAL4004', `the series '${edit.uid}' makes no occurrence ${id}`, `${at}/recurrenceId`);
  addExdate(plan, master, shape, id);
}

/**
 * Remove the event, or one occurrence's own VEVENT.
 * @param {Plan} plan
 * @param {Group} group
 * @param {Record<string, any>} edit
 * @param {string} at
 */
function remove(plan, group, edit, at) {
  const id = edit.recurrenceId;
  if (id !== undefined) {
    const own = nodeOf(plan, group, edit.uid, id, at);
    if (own === null)
      refuse('ICAL4002', `no VEVENT holds the occurrence ${id} of '${edit.uid}'`, `${at}/recurrenceId`);
    plan.change(/** @type {number} */ (own.from), /** @type {number} */ (own.to), '');
    return;
  }
  for (const node of [...group.masters, ...[...group.overrides.values()].flat()])
    plan.change(/** @type {number} */ (node.from), /** @type {number} */ (node.to), '');
}

/**
 * Admit one edit's shape.
 * @param {unknown} edit
 * @param {string} at
 * @returns {Record<string, any>}
 */
function admitEdit(edit, at) {
  if (edit === null || typeof edit !== 'object' || Array.isArray(edit))
    refuse('ICAL4001', 'an edit is an object { op, uid, ... }', at);
  const { op, uid } = /** @type {Record<string, any>} */ (edit);
  if (typeof op !== 'string' || !Object.hasOwn(MEMBERS, op))
    refuse('ICAL4001', `op is one of ${Object.keys(MEMBERS).join(', ')}, not ${typeof op === 'string' ? `'${op}'` : typeof op}`, `${at}/op`);
  const members = /** @type {readonly string[]} */ (/** @type {any} */ (MEMBERS)[op]);
  for (const key of Object.keys(edit)) {
    if (key !== 'op' && key !== 'uid' && !members.includes(key))
      refuse('ICAL4001', `a ${op} edit takes no '${key}'`, `${at}/${key}`);
  }
  if (typeof uid !== 'string' || uid === '')
    refuse('ICAL4001', 'uid is the event\'s UID, a non-empty string', `${at}/uid`);
  const id = /** @type {Record<string, any>} */ (edit).recurrenceId;
  if (id !== undefined && typeof id !== 'string')
    refuse('ICAL4001', 'recurrenceId is a string, as an occurrence spells it', `${at}/recurrenceId`);
  if ((op === 'move' || op === 'exdate') && id === undefined)
    refuse('ICAL4001', `a ${op} edit names its occurrence (recurrenceId)`, `${at}/recurrenceId`);
  if (op === 'move' && /** @type {Record<string, any>} */ (edit).start === undefined)
    refuse('ICAL4001', 'a move edit names the new start', `${at}/start`);
  if (Object.hasOwn(TEXT_EDITS, op)) {
    const member = /** @type {any} */ (TEXT_EDITS)[op][1];
    const value = /** @type {Record<string, any>} */ (edit)[member];
    if (value !== null && typeof value !== 'string')
      refuse('ICAL4001', `${member} is a string, or null to remove it`, `${at}/${member}`);
  }
  return /** @type {Record<string, any>} */ (edit);
}

/**
 * What an edit reaches, for the refusal of two edits that reach one
 * thing: its event, the component it writes in (the event's own VEVENT
 * or an occurrence's), and the lines or occurrence it writes.
 * @param {Record<string, any>} edit
 * @returns {{ key: string, whole: boolean }[]}
 */
function claimsOf(edit) {
  const event = `${edit.uid}\u0000`;
  const id = edit.recurrenceId;
  const component = `${event}${id === undefined ? 'event' : `occurrence ${id}`}`;
  if (edit.op === 'remove')
    return id === undefined ? [{ key: event, whole: true }] : [{ key: event, whole: false }, { key: component, whole: true }];
  const claims = [{ key: event, whole: false }, { key: component, whole: false }];
  if (Object.hasOwn(TEXT_EDITS, edit.op))
    return [...claims, { key: `${component}\u0000${/** @type {any} */ (TEXT_EDITS)[edit.op][0]}`, whole: true }];
  if (edit.op === 'cancel' && id === undefined)
    return [...claims, { key: `${component}\u0000STATUS`, whole: true }];
  return [...claims, { key: `${event}slot ${id}`, whole: true }];
}

//#endregion

/**
 * Edit iCalendar read in lossless mode and re-emit it: every octet no
 * edit reaches is the input's own (folding, line breaks, unknown and X-
 * content, order), and each edit changes only the lines it owns. The
 * edits are checked against the model the same read produced and all
 * planned before anything is emitted; one the tree cannot hold without
 * losing or contradicting content is refused with its code, and then
 * nothing is returned. With no edits the output is the input.
 * @param {import('./ical-read.js').IcalTree} tree - `parseIcal(text, { mode: 'lossless' }).tree`
 * @param {readonly IcalEdit[]} [edits]
 * @returns {string | Uint8Array} the calendar: a string when a string was read, octets when octets were
 * @throws {IcalError} `ICAL4001`-`ICAL4011` for an edit refused; `ICAL3004` for text iCalendar cannot carry,
 *   `ICAL3006` for a fraction of a second, `ICAL3007` for an end not after its start or given with a duration
 * @example
 * const { tree } = parseIcal(text, { mode: 'lossless' });
 * const edited = patchIcal(tree, [
 *   { op: 'retitle', uid: 'standup', summary: 'Stand-up (room 2)' },
 *   { op: 'cancel', uid: 'standup', recurrenceId: '2026-03-09T09:00:00' },
 * ]);
 */
export function patchIcal(tree, edits = []) {
  if (tree === null || typeof tree !== 'object' || !TREES.has(tree))
    refuse('ICAL4011', "patchIcal edits the tree parseIcal(text, { mode: 'lossless' }) returned", '');
  if (!Array.isArray(edits))
    refuse('ICAL4001', 'the edits are a list', '/edits');
  const plan = new Plan(tree);
  for (const [i, raw] of edits.entries()) {
    const at = `/edits/${i}`;
    const edit = admitEdit(raw, at);
    plan.claim(edit, i);
    const group = groupOf(plan, edit, at);
    if (Object.hasOwn(TEXT_EDITS, edit.op)) {
      const [name, member] = /** @type {any} */ (TEXT_EDITS)[edit.op];
      const node = nodeOf(plan, group, edit.uid, edit.recurrenceId, at);
      if (node === null)
        refuse('ICAL4002', `no VEVENT holds the occurrence ${edit.recurrenceId} of '${edit.uid}'; move it first`, `${at}/recurrenceId`);
      setText(plan, node, name, edit[member], `${at}/${member}`);
    }
    else if (edit.op === 'move')
      move(plan, group, edit, at);
    else if (edit.op === 'cancel')
      cancel(plan, group, edit, at);
    else if (edit.op === 'exdate')
      exdate(plan, group, edit, at);
    else
      remove(plan, group, edit, at);
  }
  if (plan.changes.length === 0)
    return tree.form === 'text' ? decoder.decode(tree.source) : tree.source.slice();
  const bytes = plan.emit();
  const out = tree.form === 'text' ? decoder.decode(bytes) : bytes;
  verify(plan, out, /** @type {Record<string, any>[]} */ (edits));
  return out;
}

/**
 * Read the output under the tree's options: every event an edit reached
 * and did not remove is still in the model.
 * @param {Plan} plan
 * @param {string | Uint8Array} out
 * @param {Record<string, any>[]} edits
 */
function verify(plan, out, edits) {
  let read;
  try {
    read = parseIcal(out, plan.options);
  }
  catch (error) {
    refuse('ICAL4012', `the edited calendar does not read back: ${/** @type {Error} */ (error).message}`, '/edits', error);
  }
  const held = new Set(read.calendar.components.map((component) => component.series?.uid ?? component.uid));
  for (const [i, edit] of edits.entries()) {
    if (edit.op === 'remove' && edit.recurrenceId === undefined)
      continue;
    if (plan.model.has(edit.uid) && !held.has(edit.uid)) {
      const entry = read.report.unsupported.find((item) => item.withheld === true);
      refuse('ICAL4012', `after the edit the read would withhold the event '${edit.uid}'${entry === undefined ? '' : `: ${entry.code} ${entry.reason}`}`,
        `/edits/${i}`, entry);
    }
  }
}

//#endregion
