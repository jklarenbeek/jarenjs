//@ts-check
/**
 * @file `http()` — the REST binding of one operation (CONTRACT-FORMAT
 * §4), written as the format spells it and checked as far as the pen can
 * see. The path template scan mirrors the compiler's own parser: every
 * form §4.2 reserves is refused by name with `JL0102`, at build time,
 * before `compileContract` would answer `JC0008` with the same meaning.
 * Nothing is canonicalized here — a `:name` template is written as the
 * author declared it, and the projections are what show the `{name}`
 * form.
 */

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

/** `[A-Za-z_][A-Za-z0-9_]*` — a path variable's name. */
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The RFC 6570 operators a `{…}` expression may open with; all reserved. */
const OPERATORS = '+#./;?&=';

/**
 * One static segment: any character but the structural ones (`/ { } : *
 * ? #`), whitespace and controls; a `%` must open a well-formed escape.
 * @param {string} segment
 * @param {string} at
 */
function checkStatic(segment, at) {
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '{' || ch === '}') {
      throw new LinqBuildError('JL0102',
        `a variable must be a whole segment ("{name}"), found "${segment}" — the format `
        + 'reserves a variable that is only part of a segment', at);
    }
    if (ch === ':') {
      throw new LinqBuildError('JL0102',
        `":" is reserved for a variable segment (":name"), found "${segment}"`, at);
    }
    if (ch === '*') {
      throw new LinqBuildError('JL0102',
        `"*" is a reserved wildcard form; $contract 0.1 has no wildcards, found "${segment}"`, at);
    }
    if (ch === '?' || ch === '#') {
      throw new LinqBuildError('JL0102',
        `"${ch}" cannot appear in a path template (the query and fragment are not part of `
        + 'the path)', at);
    }
    const code = segment.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) {
      throw new LinqBuildError('JL0102',
        `whitespace or a control character in segment "${segment}"`, at);
    }
    if (ch === '%') {
      if (!/^[0-9A-Fa-f]{2}$/.test(segment.slice(i + 1, i + 3))) {
        throw new LinqBuildError('JL0102',
          `a malformed percent-escape in segment "${segment}"`, at);
      }
      i += 2;
    }
  }
}

/**
 * The variables a template declares, refusing every reserved form by
 * name (§4.2). Mirrors the compiler's parser; nothing is rewritten.
 * @param {any} source
 * @param {string} at
 * @returns {string[]} the variable names, in order
 */
export function pathVariables(source, at) {
  if (typeof source !== 'string') {
    throw new LinqBuildError('JL0102',
      `http() path is a path template string, got ${describeValue(source)}`, at);
  }
  if (source.length === 0 || source[0] !== '/') {
    throw new LinqBuildError('JL0102', 'a path template must start with "/"', at);
  }
  /** @type {string[]} */
  const variables = [];
  if (source === '/') return variables;
  const segments = source.slice(1).split('/');
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment.length === 0) {
      throw new LinqBuildError('JL0102', i === segments.length - 1
        ? 'a trailing "/" declares an empty segment; the root template "/" is the only empty path'
        : 'an empty segment ("//")', at);
    }
    /** @type {string | null} */
    let name = null;
    if (segment[0] === '{') {
      if (segment[segment.length - 1] !== '}') {
        throw new LinqBuildError('JL0102',
          `a variable must be a whole segment ("{name}"), found "${segment}" — the format `
          + 'reserves a variable that is only part of a segment', at);
      }
      name = segment.slice(1, -1);
      if (name.length > 0 && OPERATORS.includes(name[0])) {
        throw new LinqBuildError('JL0102',
          `"{${name}}" uses the reserved RFC 6570 operator "${name[0]}"; $contract 0.1 `
          + 'supports only "{name}"', at);
      }
      const last = name[name.length - 1];
      if (last === '+' || last === '*') {
        throw new LinqBuildError('JL0102',
          `"{${name}}" uses the reserved "${last}" expansion modifier; $contract 0.1 has no `
          + 'wildcards', at);
      }
      if (name.includes(',') || name.includes(':')) {
        throw new LinqBuildError('JL0102',
          `"{${name}}" uses a reserved RFC 6570 list or prefix form; $contract 0.1 supports `
          + 'only "{name}"', at);
      }
    }
    else if (segment[0] === ':') {
      name = segment.slice(1);
      if (name.length === 0 || name.includes('{') || name.includes('}')) {
        throw new LinqBuildError('JL0102',
          `":name" must be a whole segment with an identifier name, found "${segment}"`, at);
      }
      const last = name[name.length - 1];
      if (last === '*' || last === '+' || last === '?') {
        throw new LinqBuildError('JL0102',
          `":${name}" uses a reserved "${last}" modifier; $contract 0.1 has no wildcards or `
          + 'optional segments', at);
      }
    }
    if (name === null) {
      checkStatic(segment, at);
      continue;
    }
    if (!IDENT.test(name)) {
      throw new LinqBuildError('JL0102',
        `a variable name must match [A-Za-z_][A-Za-z0-9_]*, found "${name}"`, at);
    }
    if (variables.includes(name)) {
      throw new LinqBuildError('JL0102', `the variable "${name}" is declared twice`, at);
    }
    variables.push(name);
  }
  return variables;
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
