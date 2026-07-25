//@ts-check
/**
 * @file Gantt grammar → gantt AST: a schedule DAG. Header
 * directives (`title`, `dateFormat`, `axisFormat`, `excludes`) go to
 * `meta`; `section` groups tasks; task rows keep their raw metadata
 * string (`:done, id, 2014-01-06, 3d`) verbatim, geometry-free.
 */

const HEADER_KEYS = new Set(['title', 'dateFormat', 'axisFormat', 'excludes', 'todayMarker', 'tickInterval', 'weekday']);

/**
 * @param {string[]} lines
 * @returns {object}
 */
export function parseGantt(lines) {
  const meta = {};
  const sections = [];
  let current = { name: null, tasks: [] };
  sections.push(current);

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (line === '' || line.startsWith('%%')) continue;
    const sp = line.indexOf(' ');
    const key = sp === -1 ? line : line.slice(0, sp);

    if (HEADER_KEYS.has(key)) {
      meta[key] = sp === -1 ? '' : line.slice(sp + 1).trim();
      continue;
    }
    if (key === 'section') {
      current = { name: line.slice('section'.length).trim(), tasks: [] };
      sections.push(current);
      continue;
    }
    // Task row: `Name : meta`
    const colon = line.indexOf(':');
    if (colon !== -1) {
      const name = line.slice(0, colon).trim();
      const info = line.slice(colon + 1).trim();
      current.tasks.push({ name, info });
    }
  }

  // Drop a leading empty default section if unused.
  const trimmed = sections[0].name === null && sections[0].tasks.length === 0
    ? sections.slice(1) : sections;
  return { meta, sections: trimmed };
}
