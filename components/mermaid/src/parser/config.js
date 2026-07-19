//@ts-check
/**
 * @file Config extraction: the leading `---` front-matter block and any
 * `%%{init: {...}}%%` directives → a plain-JSON `config` (MERMAID-FORMAT
 * §3, design decision D4).
 *
 * The raw source is never consumed here — this returns the cleaned body
 * (front-matter, init directives and `%%` comments removed) plus the
 * merged config and title, and the original source stays in the
 * Markdown fence `value` so `toMarkdown` round-trips verbatim.
 *
 * Front-matter is a YAML subset. The engine may NOT statically import
 * `@jarenjs/md` (two-layer rule), so a small built-in subset parser is
 * the default; a host that already has `@jarenjs/md` can inject its
 * richer `parseFrontmatter` through `options.parseFrontmatter` (D4).
 */

/** A leading front-matter fence: `---` on its own line at the very top. */
const FM_OPEN = /^---[ \t]*$/;
/** An `%%{init: {...}}%%` (or `%%{ init: ... }%%`) directive line. */
const RE_INIT = /^\s*%%\{\s*(?:init|initialize)\s*:\s*([\s\S]*?)\}%%\s*$/;
/** A whole-line `%%` comment (but not an `%%{...}%%` directive). */
const RE_COMMENT = /^\s*%%(?!\{)/;

/**
 * @typedef {object} MermaidConfigResult
 * @property {Record<string, any>} config merged config object
 * @property {string|null} title front-matter `title`, if any
 * @property {string} body source with front-matter/init/comments stripped
 */

/**
 * Extract config + title and return the cleaned diagram body.
 * @param {string} source
 * @param {{ parseFrontmatter?: (text: string) => any }} [options]
 * @returns {MermaidConfigResult}
 */
export function parseMermaidConfig(source, options = {}) {
  const normalized = source.replace(/\r\n?/g, '\n');
  /** @type {Record<string, any>} */
  let config = {};
  let title = null;
  let rest = normalized;

  // 1. Front-matter: `---` … `---` only when it is the very first line.
  const firstNl = rest.indexOf('\n');
  if (firstNl !== -1 && FM_OPEN.test(rest.slice(0, firstNl))) {
    const closeAt = findFrontmatterClose(rest, firstNl + 1);
    if (closeAt !== -1) {
      const fmText = rest.slice(firstNl + 1, closeAt.start);
      const parsed = options.parseFrontmatter
        ? safeCall(options.parseFrontmatter, fmText)
        : parseYamlSubset(fmText);
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.title === 'string') title = parsed.title;
        if (parsed.config && typeof parsed.config === 'object') {
          config = mergeConfig(config, parsed.config);
        }
      }
      rest = rest.slice(closeAt.end);
    }
  }

  // 2. Init directives + comment stripping, line by line.
  const lines = rest.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const initMatch = RE_INIT.exec(line);
    if (initMatch) {
      const obj = parseLooseObject(initMatch[1]);
      if (obj && typeof obj === 'object') config = mergeConfig(config, obj);
      continue;
    }
    if (RE_COMMENT.test(line)) continue;
    out.push(line);
  }

  return { config, title, body: out.join('\n') };
}

/**
 * Find the closing `---` fence starting at `from`.
 * @param {string} text
 * @param {number} from
 * @returns {{ start: number, end: number } | -1}
 */
function findFrontmatterClose(text, from) {
  let pos = from;
  while (pos < text.length) {
    let nl = text.indexOf('\n', pos);
    if (nl === -1) nl = text.length;
    const line = text.slice(pos, nl);
    if (FM_OPEN.test(line)) {
      return { start: pos, end: nl === text.length ? nl : nl + 1 };
    }
    pos = nl + 1;
    if (nl === text.length) break;
  }
  return -1;
}

/**
 * Parse a small YAML subset: `key: value` and one level of nesting via
 * two-space indentation. Values are scalars (string/number/bool/null).
 * Deliberately minimal — the documented default when `@jarenjs/md`'s
 * parser is not injected.
 * @param {string} text
 * @returns {Record<string, any>}
 */
export function parseYamlSubset(text) {
  const lines = text.split('\n');
  const root = {};
  /** @type {{ indent: number, obj: Record<string, any> }[]} */
  const stack = [{ indent: -1, obj: root }];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    let indent = 0;
    while (indent < raw.length && raw.charCodeAt(indent) === 0x20) indent++;
    const colon = raw.indexOf(':', indent);
    if (colon === -1) continue;
    const key = raw.slice(indent, colon).trim();
    const valueText = raw.slice(colon + 1).trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (valueText === '') {
      const child = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
    }
    else {
      parent[key] = parseScalar(valueText);
    }
  }
  return root;
}

/**
 * @param {string} v
 * @returns {any}
 */
function parseScalar(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

/**
 * Parse the relaxed object inside `%%{init: … }%%`. Tries strict JSON
 * first, then a light normalization (quote bare keys, single→double
 * quotes). Returns `null` on failure (config parsing never throws).
 * @param {string} text
 * @returns {Record<string, any> | null}
 */
export function parseLooseObject(text) {
  const trimmed = text.trim();
  const src = trimmed.startsWith('{') ? trimmed : '{' + trimmed + '}';
  try {
    return JSON.parse(src);
  }
  catch {
    // fall through to lenient
  }
  try {
    const lenient = src
      .replace(/'/g, '"')
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3');
    return JSON.parse(lenient);
  }
  catch {
    return null;
  }
}

/**
 * Shallow-merge nested config objects (one level deep for per-type
 * keys like `flowchart`), returning a fresh object.
 * @param {Record<string, any>} base
 * @param {Record<string, any>} extra
 * @returns {Record<string, any>}
 */
function mergeConfig(base, extra) {
  const out = { ...base };
  for (const key of Object.keys(extra)) {
    const value = extra[key];
    if (value && typeof value === 'object' && !Array.isArray(value)
      && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = { ...out[key], ...value };
    }
    else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * @param {(text: string) => any} fn
 * @param {string} text
 * @returns {any}
 */
function safeCall(fn, text) {
  try {
    return fn(text);
  }
  catch {
    return null;
  }
}
