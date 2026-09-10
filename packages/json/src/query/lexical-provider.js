//@ts-check
/** Query predicates and facets run over the complete lexical membership before slicing. */
import { compileJsonQuery } from './index.js';
import { canonicalizeJson } from '../canonical.js';
import { compareCodePoints } from '@jarenjs/core/string';

/** Compose a resident index with authoritative row access, without retaining a second catalog.
 * compile(request) pins the source revision, filter, facets and ordering once.
 * @param {any} index @param {{row?:(id:string)=>any}} [options] */
export function createLexicalProvider(index, options = {}) {
  if (typeof index?.search !== 'function' || typeof index?.stats !== 'function') throw new TypeError('Invalid lexical index');
  return {
    compile(input = {}) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).some((key) => !['where', 'facets', 'order', 'sourceRevision', 'limit', 'credits', 'after'].includes(key)))
        throw new TypeError('Invalid lexical request');
      const spec = structuredClone(input), facets = spec.facets ?? [];
      if (!Array.isArray(facets) || facets.length > 16 || facets.some((field) => typeof field !== 'string' || !field)
        || new Set(facets).size !== facets.length) throw new TypeError('Invalid lexical facets');
      if ((spec.where !== undefined || facets.length || spec.order) && typeof options.row !== 'function')
        throw new TypeError('Lexical filtering, facets and ordering require authoritative row access');
      if (spec.order && (typeof spec.order.field !== 'string' || !['asc', 'desc'].includes(spec.order.direction ?? 'asc')))
        throw new TypeError('Invalid lexical order');
      const where = spec.where === undefined ? null : compileJsonQuery(spec.where);
      const sourceRevision = spec.sourceRevision ?? index.stats().sourceRevision;
      if (typeof sourceRevision !== 'string') throw new TypeError('Invalid lexical source revision');
      const query = canonicalizeJson({ where: spec.where ?? null, facets, order: spec.order ?? null });
      const row = (id) => { const value = options.row(id);
        if (!value || value.id !== id) throw new TypeError('Missing authoritative lexical row'); return value; };
      const compare = spec.order ? (a, b) => {
        const left = row(a.id)[spec.order.field], right = row(b.id)[spec.order.field];
        if (typeof left !== typeof right || !['number', 'string'].includes(typeof left)
          || (typeof left === 'number' && (!Number.isFinite(left) || !Number.isFinite(right)))) throw new TypeError('Incomparable lexical order keys');
        const result = typeof left === 'string' ? compareCodePoints(left, right) : left - right;
        return spec.order.direction === 'desc' ? -result : result;
      } : undefined;
      return (text) => {
        const counts = facets.map(() => new Map());
        const result = index.search(text, { sourceRevision, limit: spec.limit, credits: spec.credits, after: spec.after, query, compare,
          filter: where ? (hit) => where.ebv(row(hit.id)) : undefined,
          onMatch: facets.length ? (hit) => { const value = row(hit.id);
            facets.forEach((field, i) => {
              const key = Object.hasOwn(value, field) ? value[field] ?? null : null;
              if ((!['string', 'number', 'boolean'].includes(typeof key) && key !== null) || (typeof key === 'number' && !Number.isFinite(key))) throw new TypeError('Facet values must be scalar');
              counts[i].set(key, (counts[i].get(key) ?? 0) + 1);
            });
          } : undefined,
        });
        return { ...result, facets: result.state === 'complete' ? Object.fromEntries(facets.map((field, i) =>
          [field, [...counts[i]].map(([value, count]) => ({ value, count }))])) : null };
      };
    },
  };
}
