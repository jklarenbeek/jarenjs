//@ts-check

//#region iCalendar content-line machine
// The syntax layer of the iCalendar reader (RFC 5545 §3.1-3.2, §3.4): an
// incremental machine fed chunks of octets or text that unfolds content
// lines, splits each into its name, parameters and value, and tracks the
// nesting of BEGIN/END. It knows nothing of what a property means; it
// hands each property of the calendar, and each whole component directly
// inside the calendar (its properties and nested components with it), to
// a sink.
//
// It runs on octets, not on text. A line is folded by CRLF plus one space
// or tab, and exporters fold at 75 octets even inside a UTF-8 sequence:
// only bytes can be unfolded before they are decoded. Each unfolded line
// is then decoded strictly, so text that is not UTF-8 is refused
// (`ICAL1001`) and never replaced. A string chunk is encoded first (a
// high surrogate at its end waits for the next chunk), so octets are what
// every limit counts.
//
// A line is complete only when the octet after its line break is seen
// (a space or tab there continues it), or at the end of the input. The
// state between chunks is the line's bytes so far and one of four
// states, so a chunk boundary anywhere - inside a UTF-8 sequence, a CRLF,
// a fold or an escape - never changes what is read.
//
// Line ends: CRLF, as the RFC requires. A bare line feed is read as CRLF
// and reported (`ICAL1010`), as the CSV reader reads `\n` and `\r\n` alike
// (its `CSV1006` hint: "use \n or \r\n to end a record"); a carriage
// return no line feed follows is refused (`ICAL1004`), as it is a CSV
// repair, never a plain reading. A UTF-8 byte order mark at the very
// start is skipped. Empty lines carry nothing and are skipped.

import { IcalError, ICAL_LIMIT_CODES } from './ical-wire.js';
import { JoslLimitError } from './limits.js';

const CR = 0x0D;
const LF = 0x0A;
const SP = 0x20;
const HTAB = 0x09;
const DQUOTE = 0x22;
const COMMA = 0x2C;
const COLON = 0x3A;
const SEMICOLON = 0x3B;
const BOM = [0xEF, 0xBB, 0xBF];

const S_LINE = 0; // inside a line
const S_CR = 1; // after a carriage return
const S_BREAK = 2; // after a line break: a space or tab folds, anything else starts a line

// every control character but the tab (RFC 5545 §3.1, CONTROL)
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0A-\x1F\x7F]/;

/**
 * A name of a property, parameter or component: `iana-token` or
 * `x-name`, letters, digits and dashes.
 * @param {number} c
 * @returns {boolean}
 */
const isNameCode = (c) => (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39) || c === 0x2D;

/**
 * One parameter of a content line: its name in upper case, and its
 * values, quotes removed (RFC 6868 caret escapes are not decoded).
 * @typedef {Object} IcalParameter
 * @property {string} name
 * @property {string[]} values
 */

/**
 * One unfolded content line.
 * @typedef {Object} IcalProperty
 * @property {string} name - upper case
 * @property {IcalParameter[]} params
 * @property {string} value - as written, escapes kept
 * @property {number} line - the physical line it starts on, from 1
 * @property {string} path - `/VCALENDAR/VEVENT[0]/DTSTART`
 * @property {number} [from] - kept spans only: the octet its first physical line starts at
 * @property {number} [to] - kept spans only: the octet after its last line break (or the input's end)
 */

/**
 * One component: its properties and the components nested in it, in
 * the order they were read.
 * @typedef {Object} IcalNode
 * @property {string} name - upper case
 * @property {number} line - the line of its BEGIN
 * @property {string} path - `/VCALENDAR/VEVENT[0]`
 * @property {IcalProperty[]} props
 * @property {IcalNode[]} children
 * @property {Map<string, number>} counts - components of each name seen inside it so far
 * @property {number} [from] - kept spans only: the octet its BEGIN line starts at
 * @property {number} [head] - kept spans only: the octet after its BEGIN line
 * @property {number} [tail] - kept spans only: the octet its END line starts at
 * @property {number} [to] - kept spans only: the octet after its END line
 */

/**
 * Where the machine hands what it reads.
 * @typedef {Object} IcalSink
 * @property {(prop: IcalProperty) => void} property - a property of the calendar itself
 * @property {(node: IcalNode) => void} component - a whole component directly inside the calendar
 * @property {(line: number) => void} lineFeed - a line ended in a bare line feed
 */

/**
 * The limits the machine checks, each a positive integer or Infinity.
 * @typedef {Object} IcalMachineLimits
 * @property {number} maxOctets
 * @property {number} maxComponents
 * @property {number} maxLineOctets
 * @property {number} maxParameters
 * @property {number} maxDepth
 * @property {number} maxProperties
 */

/**
 * The incremental content-line machine. With `keep`, every property and
 * component carries the octet span of its own lines (folds and line
 * breaks included; an empty line between two lines belongs to neither),
 * and the calendar keeps the components directly inside it as children,
 * so a caller holding the input can address its untouched bytes.
 */
export class IcalMachine {
  #limits;
  #sink;
  #keep;
  /** the octet the line being read starts at */
  #start = 0;
  /** the span of the line just completed */
  #from = 0;
  #to = 0;
  #state = S_LINE;
  #failed = false;
  #ended = false;
  /** octets of the calendar the BOM check has matched at the start */
  #bom = 0;
  #octets = 0;
  #physical = 1;
  #lineAt = 1;
  #buffer = new Uint8Array(256);
  #length = 0;
  /** a high surrogate a string chunk ended on */
  #high = '';
  #encoder = new TextEncoder();
  #decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  /** @type {IcalNode[]} */
  #stack = [];
  /** @type {IcalNode | null} */
  #calendar = null;
  #components = 0;

  /**
   * @param {IcalMachineLimits} limits
   * @param {IcalSink} sink
   * @param {boolean} [keep] - record octet spans and keep the calendar's components
   */
  constructor(limits, sink, keep = false) {
    this.#limits = limits;
    this.#sink = sink;
    this.#keep = keep;
  }

  /**
   * Feed a chunk: octets (`Uint8Array`) or text. A chunk may end
   * anywhere.
   * @param {string | Uint8Array} chunk
   */
  feed(chunk) {
    this.#open();
    try {
      if (typeof chunk === 'string')
        this.#text(chunk);
      else if (chunk instanceof Uint8Array) {
        if (this.#high !== '')
          this.#fail('ICAL1001', 'a string chunk ended on a high surrogate and octets followed');
        this.#bytes(chunk);
      }
      else
        throw new TypeError(`an iCalendar chunk is a string or a Uint8Array, not ${chunk === null ? 'null' : typeof chunk}`);
    }
    catch (error) {
      this.#failed = true;
      throw error;
    }
  }

  /**
   * End the input: complete the last line and check that every component
   * is closed.
   */
  end() {
    this.#open();
    try {
      if (this.#high !== '')
        this.#fail('ICAL1001', 'the input ends on a lone high surrogate');
      if (this.#state === S_CR)
        this.#fail('ICAL1004', 'a carriage return ends the input with no line feed');
      if (this.#length !== 0)
        this.#complete(this.#octets);
      if (!this.#ended) {
        if (this.#calendar === null)
          throw new IcalError('ICAL1007', 'the input holds no BEGIN:VCALENDAR', '', undefined, this.#physical);
        const open = this.#stack[this.#stack.length - 1];
        throw new IcalError('ICAL1006', `the input ends inside ${open.name}, begun on line ${open.line}`, open.path, undefined, this.#physical);
      }
      this.#failed = true;
    }
    catch (error) {
      this.#failed = true;
      throw error;
    }
  }

  /** The calendar component, once its BEGIN is read. */
  get calendar() {
    return this.#calendar;
  }

  /** Refuse input after the end or a refusal. */
  #open() {
    if (this.#failed)
      throw new IcalError('ICAL1009', 'the reader has ended or stopped', '', undefined, this.#physical);
  }

  /**
   * Refuse at the current line.
   * @param {string} code
   * @param {string} reason
   * @returns {never}
   */
  #fail(code, reason) {
    throw new IcalError(code, reason, this.#path(), undefined, this.#lineAt);
  }

  /** The path of the innermost open component. */
  #path() {
    return this.#stack.length === 0 ? '' : this.#stack[this.#stack.length - 1].path;
  }

  /**
   * Encode a text chunk and read its octets. A lone surrogate is refused
   * where it stands: the octets before it are read first, so the refusal
   * is the same wherever the chunks break.
   * @param {string} chunk
   */
  #text(chunk) {
    let text = this.#high + chunk;
    this.#high = '';
    if (text.length === 0)
      return;
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xD800 && last <= 0xDBFF) {
      this.#high = text[text.length - 1];
      text = text.slice(0, -1);
    }
    if (!text.isWellFormed()) {
      let i = 0;
      for (; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF && i + 1 < text.length) {
          const d = text.charCodeAt(i + 1);
          if (d >= 0xDC00 && d <= 0xDFFF) {
            i++;
            continue;
          }
        }
        if (c >= 0xD800 && c <= 0xDFFF)
          break;
      }
      this.#high = '';
      this.#bytes(this.#encoder.encode(text.slice(0, i)));
      this.#fail('ICAL1001', 'a string holds a lone surrogate, which is no UTF-8');
    }
    this.#bytes(this.#encoder.encode(text));
  }

  /**
   * Read octets. The total is checked first: past `maxOctets` only the
   * octets up to the limit are read, then the limit refuses.
   * @param {Uint8Array} chunk
   */
  #bytes(chunk) {
    let n = chunk.length;
    const base = this.#octets;
    const room = this.#limits.maxOctets - this.#octets;
    const over = n > room;
    if (over)
      n = room;
    this.#octets += n;
    let i = 0;
    while (this.#bom < 3 && i < n) {
      if (chunk[i] === BOM[this.#bom]) {
        this.#bom++;
        i++;
        if (this.#bom === 3)
          this.#start = base + i;
        continue;
      }
      // not a byte order mark: the octets matched so far are text
      if (this.#bom > 0)
        this.#append(Uint8Array.from(BOM.slice(0, this.#bom)), 0, this.#bom);
      this.#bom = 3;
    }
    while (i < n) {
      const state = this.#state;
      if (state === S_LINE) {
        let j = i;
        while (j < n) {
          const c = chunk[j];
          if (c === CR || c === LF)
            break;
          j++;
        }
        if (j > i)
          this.#append(chunk, i, j);
        if (j === n)
          break;
        if (chunk[j] === LF) {
          this.#sink.lineFeed(this.#physical);
          this.#state = S_BREAK;
        }
        else
          this.#state = S_CR;
        i = j + 1;
        continue;
      }
      const c = chunk[i];
      if (state === S_CR) {
        if (c !== LF)
          this.#fail('ICAL1004', 'a carriage return with no line feed after it');
        this.#state = S_BREAK;
        i++;
        continue;
      }
      // after a line break
      this.#physical++;
      if (c === SP || c === HTAB) {
        this.#state = S_LINE;
        i++;
        continue;
      }
      if (this.#length !== 0)
        this.#complete(base + i);
      this.#lineAt = this.#physical;
      this.#start = base + i;
      this.#state = S_LINE;
    }
    if (over)
      throw new JoslLimitError('ICAL2001', ICAL_LIMIT_CODES.ICAL2001, this.#limits.maxOctets, this.#lineAt);
  }

  /**
   * Add octets to the line, within `maxLineOctets`.
   * @param {Uint8Array} chunk
   * @param {number} from
   * @param {number} to
   */
  #append(chunk, from, to) {
    const length = this.#length + (to - from);
    if (length > this.#limits.maxLineOctets)
      throw new JoslLimitError('ICAL2004', ICAL_LIMIT_CODES.ICAL2004, this.#limits.maxLineOctets, this.#lineAt);
    if (length > this.#buffer.length) {
      const grown = new Uint8Array(Math.max(length, this.#buffer.length * 2));
      grown.set(this.#buffer.subarray(0, this.#length));
      this.#buffer = grown;
    }
    this.#buffer.set(chunk.subarray(from, to), this.#length);
    this.#length = length;
  }

  /**
   * Decode the unfolded line and read it.
   * @param {number} end - the octet after the line's last line break
   */
  #complete(end) {
    this.#from = this.#start;
    this.#to = end;
    let text;
    try {
      text = this.#decoder.decode(this.#buffer.subarray(0, this.#length));
    }
    catch {
      this.#fail('ICAL1001', 'the line holds octets that are not UTF-8');
    }
    this.#length = 0;
    if (this.#buffer.length > 65536)
      this.#buffer = new Uint8Array(256);
    this.#line(/** @type {string} */ (text));
  }

  /**
   * Split one content line and place it in the structure.
   * @param {string} text
   */
  #line(text) {
    if (CONTROL.test(text))
      this.#fail('ICAL1004', 'the line holds a control character other than a tab');
    const n = text.length;
    let i = 0;
    while (i < n && isNameCode(text.charCodeAt(i)))
      i++;
    if (i === 0)
      this.#fail('ICAL1002', 'a content line starts with a name of letters, digits and dashes');
    const name = text.slice(0, i).toUpperCase();
    /** @type {IcalParameter[]} */
    const params = [];
    while (i < n && text.charCodeAt(i) === SEMICOLON) {
      i++;
      const from = i;
      while (i < n && isNameCode(text.charCodeAt(i)))
        i++;
      if (i === from || text.charCodeAt(i) !== 0x3D)
        this.#fail('ICAL1003', `a parameter of ${name} is NAME=VALUE`);
      if (params.length >= this.#limits.maxParameters)
        throw new JoslLimitError('ICAL2005', ICAL_LIMIT_CODES.ICAL2005, this.#limits.maxParameters, this.#lineAt);
      const param = text.slice(from, i).toUpperCase();
      i++;
      /** @type {string[]} */
      const values = [];
      for (;;) {
        if (text.charCodeAt(i) === DQUOTE) {
          const close = text.indexOf('"', i + 1);
          if (close < 0)
            this.#fail('ICAL1003', `the quoted value of ${name};${param} is never closed`);
          values.push(text.slice(i + 1, close));
          i = close + 1;
          const after = text.charCodeAt(i);
          if (after !== COMMA && after !== SEMICOLON && after !== COLON)
            this.#fail('ICAL1003', `text follows the closing quote of ${name};${param}`);
        }
        else {
          const start = i;
          while (i < n) {
            const c = text.charCodeAt(i);
            if (c === DQUOTE || c === COMMA || c === SEMICOLON || c === COLON)
              break;
            i++;
          }
          if (text.charCodeAt(i) === DQUOTE)
            this.#fail('ICAL1003', `a quote inside the unquoted value of ${name};${param}`);
          values.push(text.slice(start, i));
        }
        if (text.charCodeAt(i) !== COMMA)
          break;
        i++;
      }
      params.push({ name: param, values });
    }
    if (text.charCodeAt(i) !== COLON)
      this.#fail('ICAL1002', `the line ${name} has no colon before its value`);
    const value = text.slice(i + 1);
    if (name === 'BEGIN' || name === 'END')
      this.#structure(name, params, value);
    else if (this.#keep)
      this.#property({ name, params, value, line: this.#lineAt, path: '', from: this.#from, to: this.#to });
    else
      this.#property({ name, params, value, line: this.#lineAt, path: '' });
  }

  /**
   * BEGIN or END.
   * @param {'BEGIN' | 'END'} name
   * @param {IcalParameter[]} params
   * @param {string} value
   */
  #structure(name, params, value) {
    if (params.length !== 0 || value === '' || ![...value].every((ch) => isNameCode(ch.charCodeAt(0))))
      this.#fail('ICAL1002', `${name} takes no parameter and names a component`);
    const component = value.toUpperCase();
    if (this.#ended)
      this.#fail('ICAL1007', `${name}:${component} after END:VCALENDAR`);
    const top = this.#stack[this.#stack.length - 1];
    if (name === 'END') {
      if (top === undefined || top.name !== component)
        this.#fail('ICAL1005', top === undefined ? `END:${component} with no component open` : `END:${component} inside ${top.name}, begun on line ${top.line}`);
      this.#stack.pop();
      if (this.#keep) {
        top.tail = this.#from;
        top.to = this.#to;
      }
      if (this.#stack.length === 0)
        this.#ended = true;
      else if (this.#stack.length === 1)
        this.#sink.component(top);
      return;
    }
    if (top === undefined) {
      if (component !== 'VCALENDAR' || this.#calendar !== null)
        this.#fail('ICAL1007', `BEGIN:${component} outside a calendar`);
      this.#calendar = { name: component, line: this.#lineAt, path: '/VCALENDAR', props: [], children: [], counts: new Map() };
      if (this.#keep)
        this.#spans(this.#calendar);
      this.#stack.push(this.#calendar);
      return;
    }
    if (component === 'VCALENDAR')
      this.#fail('ICAL1007', 'a calendar inside a calendar');
    if (this.#stack.length + 1 > this.#limits.maxDepth)
      throw new JoslLimitError('ICAL2006', ICAL_LIMIT_CODES.ICAL2006, this.#limits.maxDepth, this.#lineAt);
    if (++this.#components > this.#limits.maxComponents)
      throw new JoslLimitError('ICAL2002', ICAL_LIMIT_CODES.ICAL2002, this.#limits.maxComponents, this.#lineAt);
    const index = top.counts.get(component) ?? 0;
    top.counts.set(component, index + 1);
    /** @type {IcalNode} */
    const node = { name: component, line: this.#lineAt, path: `${top.path}/${component}[${index}]`, props: [], children: [], counts: new Map() };
    if (this.#keep)
      this.#spans(node);
    // a component directly inside the calendar is handed over whole;
    // one nested deeper stays with its parent (with `keep`, both stay)
    if (this.#stack.length > 1 || this.#keep)
      top.children.push(node);
    this.#stack.push(node);
  }

  /**
   * Give a component its BEGIN line's span; its END line fills the rest.
   * @param {IcalNode} node
   */
  #spans(node) {
    node.from = this.#from;
    node.head = this.#to;
    node.tail = this.#to;
    node.to = this.#to;
  }

  /**
   * A property of the open component.
   * @param {IcalProperty} prop
   */
  #property(prop) {
    if (this.#ended)
      this.#fail('ICAL1007', `${prop.name} after END:VCALENDAR`);
    const top = this.#stack[this.#stack.length - 1];
    if (top === undefined)
      this.#fail('ICAL1007', `${prop.name} before BEGIN:VCALENDAR`);
    if (top.props.length >= this.#limits.maxProperties)
      throw new JoslLimitError('ICAL2007', ICAL_LIMIT_CODES.ICAL2007, this.#limits.maxProperties, this.#lineAt);
    prop.path = `${top.path}/${prop.name}`;
    top.props.push(prop);
    // the calendar's own properties are handed over at once
    if (top === this.#calendar)
      this.#sink.property(prop);
  }
}

//#endregion
