//@ts-check
/** Ordered aggregate state shared by query evaluation and streaming hosts. */
import { compareCodePoints } from '@jarenjs/core/string';
import { EMPTY, Seq, seqOf, ebv, stableKeyString, describeItem } from './runtime.js';
import { JsonQueryRuntimeError } from './errors.js';
const runtimeError = (code, message, docPath) => new JsonQueryRuntimeError(code, message, docPath);

/**
 * Accumulate sequence ITEMS, preserving order, singleton arrays, numeric
 * errors and IEEE-754 addition order. Admission runs before a distinct item
 * is retained, allowing a host to impose its own cardinality/byte budget.
 * @param {'$count'|'$sum'|'$avg'|'$min'|'$max'|'$distinct'|'$ebv'} operator
 * @param {{ docPath?: string, admit?: (item: any) => void }} [options]
 */
function createAggregateState(operator, options = {}) {
  if (!['$count', '$sum', '$avg', '$min', '$max', '$distinct', '$ebv'].includes(operator))
    throw new TypeError(`unsupported query accumulator '${operator}'`);
  const docPath = options.docPath ?? '';
  let count = 0, total = 0, first, best, sawNaN = false;
  const seen = new Set();
  const values = [];
  const add = (item) => {
    if (operator === '$sum' || operator === '$avg') {
      if (typeof item !== 'number')
        throw runtimeError('JQ2001', `aggregate items must be numbers, got ${describeItem(item)}`, docPath);
      total += item;
    }
    if (operator === '$min' || operator === '$max') {
      if ((typeof item !== 'number' && typeof item !== 'string')
        || (count > 0 && typeof item !== typeof first))
        throw runtimeError('JQ2001', `'$min'/'$max' items must be all numbers or all strings, got ${describeItem(item)}`, docPath);
      if (count === 0) best = item;
      else {
        const order = typeof item === 'string' ? compareCodePoints(item, best)
          : item > best ? 1 : item < best ? -1 : 0;
        if (operator === '$max' ? order > 0 : order < 0) best = item;
      }
      if (typeof item === 'number' && Number.isNaN(item)) sawNaN = true;
    }
    if (operator === '$distinct') {
      const key = stableKeyString(item);
      if (!seen.has(key)) {
        options.admit?.(item);
        seen.add(key);
        values.push(item);
      }
    }
    // EBV needs at most two items; evaluation of later items still happens
    // before its final verdict, as it does for an ordinary compiled query.
    if (operator === '$ebv' && count < 2) values.push(item);
    if (count === 0) first = item;
    count++;
  };
  const result = () => {
    if (operator === '$count') return count;
    if (operator === '$distinct' || operator === '$ebv') return seqOf(values);
    if (count === 0) return operator === '$sum' ? 0 : EMPTY;
    if (operator === '$sum' || operator === '$avg')
      return count === 1 ? first : operator === '$sum' ? total : total / count;
    return sawNaN ? NaN : best;
  };
  return { add, result };
}

/**
 * Ordered state for a query aggregate or sequence EBV, fed one item at a time.
 * @param {'$count'|'$sum'|'$avg'|'$min'|'$max'|'$distinct'|'$ebv'} operator
 * @param {{ docPath?: string, admit?: (item: any) => void }} [options]
 * @returns {{ add: (item: any) => void, value: () => any, ebv: () => boolean }}
 */
export function createQueryAccumulator(operator, options = {}) {
  const state = createAggregateState(operator, options);
  return {
    add: state.add,
    value: () => {
      const value = state.result();
      return value === EMPTY ? undefined : value instanceof Seq ? value.items : value;
    },
    ebv: () => ebv(state.result(), ''),
  };
}

/** Evaluate an ordinary aggregate through the same ordered state. */
export function aggregateSequence(operator, value, docPath) {
  const state = createAggregateState(operator, { docPath });
  if (value instanceof Seq) for (const item of value.items) state.add(item);
  else if (value !== EMPTY) state.add(value);
  return state.result();
}
