//@ts-check
/** One bounded route subscription and navigation owner over an injected Window. */
import { AppRuntimeError, APP_CODES } from './errors.js';

/**
 * @typedef {{mode:'hash'|'history', path:string, query:Readonly<Record<string, readonly string[]>>, fragment:string, raw:string}} RouteRecord
 * @typedef {Object} RouteOptions
 * @property {Window} [window] - Defaults to the current browser window.
 * @property {string} [basePath='/'] - Encoded path prefix, on a segment boundary.
 * @property {number} [maxLength=8192] - Maximum URL code units, at most 65536.
 * @property {number} [maxQueryEntries=128] - At most 1024 entries, repeated keys included.
 * @property {number} [maxTurns=64] - At most 1024 deliveries per synchronous drain.
 * @property {(error:unknown) => void} [onError] - Errors from native event delivery.
 * @typedef {((props:{action:string}, dispatch:(action:string, route:Readonly<RouteRecord>)=>void)=>()=>void) & {
 * navigate:(target:string, options?:{replace?:boolean})=>void,
 * replace:(target:string)=>void, refresh:()=>void, dispose:()=>void
 * }} RouteSubscription
 */
function refuse(code) { throw new AppRuntimeError(code, APP_CODES[code]); }
const bounded = (value, max) => Number.isSafeInteger(value) && value > 0 && value <= max;

/** @param {'hash'|'history'} mode @param {RouteOptions} options @returns {RouteSubscription} */
function createRoutes(mode, options) {
  if (!options || typeof options !== 'object') refuse('JA2023');
  const win = options.window === undefined ? globalThis.window : options.window;
  const { maxLength = 8192, maxQueryEntries = 128, maxTurns = 64 } = options;
  const base = options.basePath === undefined ? '/' : options.basePath;
  if (!win?.location || typeof win.addEventListener !== 'function' || typeof win.removeEventListener !== 'function'
    || typeof win.history?.pushState !== 'function' || typeof win.history?.replaceState !== 'function'
    || !bounded(maxLength, 65536) || !bounded(maxQueryEntries, 1024) || !bounded(maxTurns, 1024)
    || typeof base !== 'string' || base.length > maxLength || !base.startsWith('/') || base.startsWith('//') || /[?#\\]/.test(base)
    || (options.onError !== undefined && typeof options.onError !== 'function')) refuse('JA2023');
  const prefix = base === '/' ? '' : base.replace(/\/+$/, '');
  let active = null, disposed = false, draining = false, turns = 0;
  const queue = [];
  const events = mode === 'hash' ? ['hashchange'] : ['popstate', 'hashchange'];

  function url(value, relative) {
    if (typeof value !== 'string') refuse('JA2023');
    if (value.length > maxLength) refuse('JA2025');
    let result;
    try { result = new URL(value, relative); } catch { return refuse('JA2024'); }
    if (result.href.length > maxLength) refuse('JA2025');
    return result;
  }
  function route(location) {
    const raw = mode === 'hash' ? location.hash : location.pathname + location.search + location.hash;
    // The actual address has already passed the URL bound. The fixed parsing
    // origin must not consume a caller's smaller real-origin budget.
    const parsed = mode === 'hash' ? new URL('https://route.invalid/' + raw.replace(/^#\/?/, '')) : location;
    if (parsed.pathname !== prefix && !parsed.pathname.startsWith(prefix + '/')) refuse('JA2024');
    const query = Object.create(null); let entries = 0;
    for (const [name, value] of parsed.searchParams) {
      if (++entries > maxQueryEntries) refuse('JA2025');
      (query[name] ??= []).push(value);
    }
    for (const values of Object.values(query)) Object.freeze(values);
    return Object.freeze({ mode, path: parsed.pathname.slice(prefix.length) || '/',
      query: Object.freeze(query), fragment: parsed.hash.slice(1), raw });
  }
  function stop(owner) {
    if (active !== owner) return;
    active = null; queue.length = 0;
    for (const event of events) win.removeEventListener(event, onChange);
  }
  function admit() {
    if (disposed || !active) refuse('JA2026');
    if (queue.length >= maxTurns || (draining && turns >= maxTurns)) refuse('JA2025');
  }
  function publish(record) {
    const owner = active;
    const tail = queue.at(-1);
    if (!owner || (tail?.owner === owner ? tail.record.raw : owner.last) === record.raw) return;
    admit(); queue.push({ owner, record });
    if (draining) return;
    draining = true; turns = 0;
    try {
      while (queue.length) {
        if (++turns > maxTurns) refuse('JA2025');
        const next = queue.shift();
        if (next.owner !== active) continue;
        next.owner.last = next.record.raw;
        next.owner.dispatch(next.owner.action, next.record);
      }
    } catch (error) { queue.length = 0; throw error; }
    finally { draining = false; turns = 0; }
  }
  function refresh() { admit(); publish(route(url(win.location.href))); }
  function onChange() {
    if (!active || disposed) return;
    try { refresh(); }
    catch (error) { if (options.onError) options.onError(error); else throw error; }
  }
  /** @type {RouteSubscription} */
  const subscribe = (props, dispatch) => {
    if (disposed || active) refuse('JA2026');
    if (typeof props?.action !== 'string' || !props.action.trim() || typeof dispatch !== 'function') refuse('JA2023');
    const owner = { action: props.action, dispatch, last: null }; active = owner;
    try { for (const event of events) win.addEventListener(event, onChange); refresh(); }
    catch (error) { stop(owner); throw error; }
    return () => stop(owner);
  };
  subscribe.navigate = (target, navigation = {}) => {
    admit();
    if (typeof target !== 'string' || !navigation || typeof navigation !== 'object'
      || (navigation.replace !== undefined && typeof navigation.replace !== 'boolean')) refuse('JA2023');
    if (target.length > maxLength) refuse('JA2025');
    const current = url(win.location.href);
    let next;
    if (mode === 'hash' && !/^[a-z][a-z0-9+.-]*:/i.test(target) && !target.startsWith('//')) {
      next = new URL(current.href); next.hash = target.startsWith('#') ? target : '#' + target;
      if (next.href.length > maxLength) refuse('JA2025');
    } else next = url(target, current.href);
    if (next.origin !== current.origin || next.username || next.password
      || !['http:', 'https:'].includes(next.protocol)
      || (mode === 'hash' && (next.pathname !== current.pathname || next.search !== current.search))) refuse('JA2024');
    const record = route(next); // validate before writing browser history
    if (next.href === current.href) { publish(record); return; }
    const method = navigation.replace ? 'replaceState' : 'pushState';
    win.history[method](navigation.replace ? win.history.state : null, '', next.href);
    publish(record);
  };
  subscribe.replace = target => subscribe.navigate(target, { replace: true });
  subscribe.refresh = refresh;
  subscribe.dispose = () => { if (disposed) return; disposed = true; if (active) stop(active); };
  return Object.freeze(subscribe);
}

/** Subscribe with {action}; native hashchange and explicit navigation share one owner.
 * @param {RouteOptions} [options] @returns {RouteSubscription} */
export function createHashRouteSubscription(options = {}) { return createRoutes('hash', options); }
/** Subscribe with {action}; observe popstate/hashchange, and refresh after external history writes.
 * @param {RouteOptions} [options] @returns {RouteSubscription} */
export function createHistoryRouteSubscription(options = {}) { return createRoutes('history', options); }
