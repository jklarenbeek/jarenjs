//@ts-check
/** The AI action document, authored without an AI client, environment or engine. */
import { DocumentBuilder, optionsOf, snapshot } from '../authored.js';
import { captureQuery } from '../capture-root.js';
import { LinqBuildError } from '../errors.js';

const FIELDS = {
  chunk: ['strategy', 'size'], grep: ['pattern', 'flags', 'limit'], select: ['query'],
  stat: [], peek: [], map: ['prompt'], reduce: ['query'], answer: ['chars'],
};
function make(op, from, as, options) {
  if (typeof from !== 'string' || !from || (op !== 'answer' && (typeof as !== 'string' || !as)))
    throw new LinqBuildError('JL0101', 'A step needs a source name and, except answer, a result name');
  return snapshot({ op, from, ...(op === 'answer' ? {} : { as }), ...optionsOf(options, FIELDS[op], `${op}()`) });
}
function expression(value) {
  // The program query receives only its input document: an undeclared external
  // is the shared capture's JL0104 refusal, not an invented environment lookup.
  return typeof value === 'function' ? captureQuery('program query', [], value, { fold: false }) : value;
}
/** Split a slot into a family of pieces. */
export function chunk(from, as, options = {}) { return make('chunk', from, as, options); }
/** Find matching slots with a bounded pattern and options. */
export function grep(from, as, options) { return make('grep', from, as, options); }
/** Query one JSON slot; a callback is captured as ordinary query JSON. */
export function select(from, as, query) { return make('select', from, as, { query: expression(query) }); }
/** Inspect counts and shape. */
export function stat(from, as) { return make('stat', from, as, {}); }
/** Inspect a slot's metadata and excerpt. */
export function peek(from, as) { return make('peek', from, as, {}); }
/** Ask one bounded prompt per member of a slot/family. */
export function map(from, as, prompt) { return make('map', from, as, { prompt }); }
/** Query the collected results of an earlier map. */
export function reduce(from, as, query) { return make('reduce', from, as, { query: expression(query) }); }
/** Declare the final answer slot and optional excerpt bound. */
export function answer(from, options = {}) { return make('answer', from, undefined, options); }

/** An immutable ordered program; binding types are phantoms. */
export class ProgramBuilder extends DocumentBuilder {
  /** Append a public step. An answer closes this builder. @param {any} value */
  step(value) {
    if (this.schema.steps.at(-1)?.op === 'answer')
      throw new LinqBuildError('JL0102', 'answer is terminal; start another program to append work');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(FIELDS, value.op))
      throw new LinqBuildError('JL0101', 'step() needs a known program operation');
    const step = optionsOf(value, ['op', 'from', ...(value.op === 'answer' ? [] : ['as']), ...FIELDS[value.op]], 'step()');
    return this.with({ steps: [...this.schema.steps, step] });
  }
  /** Append a chunk step. */
  chunk(from, as, options = {}) { return this.step(chunk(from, as, options)); }
  /** Append a grep step. */
  grep(from, as, options) { return this.step(grep(from, as, options)); }
  /** Append a select step. */
  select(from, as, query) { return this.step(select(from, as, query)); }
  /** Append a stat step. */
  stat(from, as) { return this.step(stat(from, as)); }
  /** Append a peek step. */
  peek(from, as) { return this.step(peek(from, as)); }
  /** Append a map step. */
  map(from, as, prompt) { return this.step(map(from, as, prompt)); }
  /** Append a reduce step. */
  reduce(from, as, query) { return this.step(reduce(from, as, query)); }
  /** Append the terminal answer. */
  answer(from, options = {}) { return this.step(answer(from, options)); }
}

/** Declare input slot names for TypeScript; they never become document members. @param {readonly string[]} slots */
export function program(slots = []) {
  if (!Array.isArray(slots) || slots.some((name) => typeof name !== 'string' || !name))
    throw new LinqBuildError('JL0101', 'program() takes input slot names');
  return new ProgramBuilder({ steps: [] });
}
/** A raw public program. Compilation remains authoritative for names and semantics. @param {any} document */
export function from(document) { return new ProgramBuilder(document); }
