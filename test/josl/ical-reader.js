//@ts-check

/**
 * An independent, minimal iCalendar reader for the writer's tests: it
 * works on the BYTES of the output (every physical line at most 75
 * octets, each decodable on its own as UTF-8, CRLF only), unfolds,
 * splits content lines into name, parameters and value, and unescapes
 * TEXT. It imports nothing from `packages/`: a mistake the writer makes
 * cannot be shared with the reader that checks it.
 */

import assert from 'node:assert';

const CR = 0x0D;
const LF = 0x0A;
const DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * The physical lines of a calendar, checked octet by octet.
 * @param {string} text
 * @returns {string[]}
 */
export function physicalLines(text) {
  const bytes = new TextEncoder().encode(text);
  /** @type {string[]} */
  const lines = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === LF)
      assert.fail(`a bare LF at octet ${i}`);
    if (bytes[i] !== CR)
      continue;
    assert.strictEqual(bytes[i + 1], LF, `a bare CR at octet ${i}`);
    const line = bytes.subarray(start, i);
    assert.ok(line.length <= 75, `a physical line of ${line.length} octets: ${DECODER.decode(line)}`);
    lines.push(DECODER.decode(line));
    start = i + 2;
    i++;
  }
  assert.strictEqual(start, bytes.length, 'the calendar ends in CRLF');
  return lines;
}

/**
 * Unfold: a physical line that starts with a space or a tab continues the
 * one before it, minus that one character.
 * @param {string[]} physical
 * @returns {string[]}
 */
export function unfold(physical) {
  /** @type {string[]} */
  const out = [];
  for (const line of physical) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      assert.ok(out.length > 0, 'a continuation with nothing to continue');
      out[out.length - 1] += line.slice(1);
    }
    else
      out.push(line);
  }
  return out;
}

/**
 * @typedef {{ name: string, params: Record<string, string>, value: string }} Property
 * @typedef {{ name: string, props: Property[], children: Component[] }} Component
 */

/**
 * Split one content line: NAME *(;PARAM=VALUE) : VALUE, a quoted
 * parameter value read to its closing quote.
 * @param {string} line
 * @returns {Property}
 */
export function splitLine(line) {
  const name = /^[A-Za-z0-9-]+/.exec(line);
  assert.ok(name, `no property name: ${line}`);
  let i = name[0].length;
  /** @type {Record<string, string>} */
  const params = {};
  while (line[i] === ';') {
    const key = /^[A-Za-z0-9-]+=/.exec(line.slice(i + 1));
    assert.ok(key, `a malformed parameter: ${line}`);
    i += 1 + key[0].length;
    let value;
    if (line[i] === '"') {
      const close = line.indexOf('"', i + 1);
      assert.ok(close > i, `an unclosed quoted parameter: ${line}`);
      value = line.slice(i + 1, close);
      i = close + 1;
    }
    else {
      const stop = /[;:]/.exec(line.slice(i));
      assert.ok(stop, `a parameter with no end: ${line}`);
      value = line.slice(i, i + stop.index);
      i += stop.index;
    }
    params[key[0].slice(0, -1).toUpperCase()] = value;
  }
  assert.strictEqual(line[i], ':', `no ':' after the parameters: ${line}`);
  return { name: name[0].toUpperCase(), params, value: line.slice(i + 1) };
}

/**
 * Read a calendar into its component tree.
 * @param {string} text
 * @returns {Component} the VCALENDAR
 */
export function readIcal(text) {
  /** @type {Component[]} */
  const stack = [];
  /** @type {Component | undefined} */
  let root;
  for (const line of unfold(physicalLines(text))) {
    const prop = splitLine(line);
    if (prop.name === 'BEGIN') {
      const component = { name: prop.value, props: [], children: [] };
      if (stack.length === 0) {
        assert.strictEqual(root, undefined, 'one calendar');
        root = component;
      }
      else
        stack[stack.length - 1].children.push(component);
      stack.push(component);
    }
    else if (prop.name === 'END') {
      const open = stack.pop();
      assert.strictEqual(open?.name, prop.value, `END:${prop.value} closes ${open?.name}`);
    }
    else {
      assert.ok(stack.length > 0, `a property outside any component: ${line}`);
      stack[stack.length - 1].props.push(prop);
    }
  }
  assert.strictEqual(stack.length, 0, 'every component is closed');
  assert.ok(root && root.name === 'VCALENDAR');
  return root;
}

/**
 * Unescape a TEXT value: `\\`, `\;`, `\,`, `\n` and `\N`.
 * @param {string} value
 * @returns {string}
 */
export function unescapeText(value) {
  return value.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** The one property of a name, or undefined. @param {Component} c @param {string} name */
export const prop = (c, name) => c.props.find((p) => p.name === name);

/** Every property of a name. @param {Component} c @param {string} name */
export const props = (c, name) => c.props.filter((p) => p.name === name);

/**
 * A DATE, DATE-TIME (floating or UTC) value as milliseconds: epoch for UTC,
 * a wall clock read as if UTC otherwise.
 * @param {string} value
 * @returns {{ kind: 'date' | 'floating' | 'utc', at: number }}
 */
export function timeOf(value) {
  const form = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value);
  assert.ok(form, `not a DATE or DATE-TIME: ${value}`);
  const at = new Date(0);
  at.setUTCFullYear(Number(form[1]), Number(form[2]) - 1, Number(form[3]));
  at.setUTCHours(Number(form[4] ?? 0), Number(form[5] ?? 0), Number(form[6] ?? 0), 0);
  const kind = form[4] === undefined ? 'date' : form[7] === 'Z' ? 'utc' : 'floating';
  return { kind, at: at.getTime() };
}

/**
 * A DURATION as nominal days and exact milliseconds.
 * @param {string} value
 * @returns {{ days: number, ms: number }}
 */
export function durationOf(value) {
  const form = /^P(?:(\d+)W|(\d+D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/.exec(value);
  assert.ok(form, `not a DURATION: ${value}`);
  return {
    days: Number(form[1] ?? 0) * 7 + Number((form[2] ?? '0D').slice(0, -1)),
    ms: ((Number(form[3] ?? 0) * 60 + Number(form[4] ?? 0)) * 60 + Number(form[5] ?? 0)) * 1000,
  };
}
