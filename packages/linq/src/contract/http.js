//@ts-check
/**
 * @file `http()` — the REST binding of one operation (CONTRACT-FORMAT
 * §4), written as the format spells it and checked as far as the pen can
 * see. The path template is checked by the compiler's own parser
 * (`@jarenjs/core/route`): every form §4.2 reserves is refused by name
 * with `JL0102`, at build time, before `compileContract` would answer
 * `JC0008` with the same meaning. Nothing is canonicalized here — a
 * `:name` template is written as the author declared it, and the
 * projections are what show the `{name}` form.
 */

import { parsePathTemplate } from '@jarenjs/core/route';
import { LinqBuildError } from '../errors.js';
import { describeValue, requireJson } from '../json-boundary.js';

/** The binding brand: how `defineContract` tells a checked binding apart. */
export const HTTP_BINDING = Symbol.for('@jarenjs/linq/contract-http');

/** The members `http` accepts, in the order §12.1 fixes. */
export const HTTP_MEMBERS = Object.freeze(['method', 'path', 'in', 'body', 'status', 'media']);

/** The uppercase tokens §4's table lists. */
export const HTTP_METHODS = Object.freeze(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

/** The four places an input member can travel. */
export const LOCATIONS = Object.freeze(['path', 'query', 'header', 'body']);

/**
 * The variables a template declares, refusing every reserved form by
 * name (§4.2) with the suite's one template parser (`@jarenjs/core/route`)
 * — the compiler's own, so the pen refuses earlier and never differently.
 * Nothing is rewritten: the binding keeps the template as declared.
 * @param {any} source
 * @param {string} at
 * @returns {string[]} the variable names, in order
 */
export function pathVariables(source, at) {
  if (typeof source !== 'string') {
    throw new LinqBuildError('JL0102',
      `http() path is a path template string, got ${describeValue(source)}`, at);
  }
  try {
    return [...parsePathTemplate(source).variables];
  }
  catch (error) {
    throw new LinqBuildError('JL0102', /** @type {Error} */ (error).message, at);
  }
}

/**
 * One operation's HTTP binding, checked and branded. The members are
 * written in §12.1's order — `method`, `path`, `in`, `body`, `status`,
 * `media` — and only the ones declared: a default is the compiler's to
 * materialize, never the pen's to write.
 *
 * @param {any} spec - `{ method, path, in?, body?, status?, media? }`
 * @returns {any} the binding, frozen and branded
 * @throws {LinqBuildError} `JL0101` a member that is not what it takes;
 *   `JL0102` a path template form the format reserves
 * @example
 * http({ method: 'PUT', path: '/api/products/{id}', in: { revision: 'body' } });
 */
export function http(spec) {
  if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new LinqBuildError('JL0101',
      `http() takes { method, path, in?, body?, status?, media? }, got ${describeValue(spec)}`);
  }
  for (const key of Object.keys(spec)) {
    if (!HTTP_MEMBERS.includes(key)) {
      throw new LinqBuildError('JL0101',
        `http() does not take '${key}' — the binding is ${HTTP_MEMBERS.join(', ')} `
        + '(CONTRACT-FORMAT §4)', `/${key}`);
    }
  }
  if (!HTTP_METHODS.includes(spec.method)) {
    throw new LinqBuildError('JL0101',
      `http() method is one uppercase token of ${HTTP_METHODS.join(' ')}, got `
      + `${describeValue(spec.method)}`, '/method');
  }
  const variables = pathVariables(spec.path, '/path');

  const out = { method: spec.method, path: spec.path };
  if (spec.in !== undefined) {
    const locations = requireJson(spec.in, 'http() in');
    if (locations === null || typeof locations !== 'object' || Array.isArray(locations)) {
      throw new LinqBuildError('JL0101',
        'http() in is a plain object of input member → path | query | header | body', '/in');
    }
    const placed = {};
    for (const member of Object.keys(locations)) {
      const where = locations[member];
      if (!LOCATIONS.includes(where)) {
        throw new LinqBuildError('JL0101',
          `http() in.${member} is one of ${LOCATIONS.join(', ')}, got ${describeValue(where)}`,
          `/in/${member}`);
      }
      if (where === 'path' && !variables.includes(member)) {
        throw new LinqBuildError('JL0102',
          `http() maps '${member}' to path, but the template declares no {${member}} — a `
          + 'path member is named by the template itself', `/in/${member}`);
      }
      placed[member] = where;
    }
    out.in = placed;
  }
  if (spec.body !== undefined) {
    if (typeof spec.body !== 'string' || spec.body.length === 0) {
      throw new LinqBuildError('JL0101',
        `http() body names the input member whose value IS the request body, got `
        + `${describeValue(spec.body)}`, '/body');
    }
    out.body = spec.body;
  }
  if (spec.status !== undefined) {
    if (!Number.isInteger(spec.status) || spec.status < 200 || spec.status > 299) {
      throw new LinqBuildError('JL0101',
        `http() status is an integer in 200–299, got ${describeValue(spec.status)}`, '/status');
    }
    out.status = spec.status;
  }
  if (spec.media !== undefined) {
    if (typeof spec.media !== 'string' || spec.media.length === 0) {
      throw new LinqBuildError('JL0101',
        `http() media is a media type, got ${describeValue(spec.media)}`, '/media');
    }
    out.media = spec.media;
  }
  Object.defineProperty(out, HTTP_BINDING, { value: true, enumerable: false });
  return Object.freeze(out);
}

/**
 * Whether a value is an `http()` binding (as opposed to the same members
 * written by hand, which `defineContract` accepts and checks the same way).
 * @param {any} value
 * @returns {boolean}
 */
export function isHttpBinding(value) {
  return value !== null && typeof value === 'object' && value[HTTP_BINDING] === true;
}
