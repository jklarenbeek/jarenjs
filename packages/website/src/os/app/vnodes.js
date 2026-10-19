//@ts-check
/**
 * The vnode vocabulary every OS window is written in: the line icons, in
 * the OS's own drawing style (round caps, one weight, `currentColor` so
 * they follow the theme), and the small builders the view stylesheets
 * use for what repeats — a button bound to an action, a conditional, a
 * status pill, a window's heading. Each returns plain JSON: a vnode, or
 * the query document that computes one.
 */

/** Line icons in the OS's own drawing style: round caps, one weight,
 * drawn with `currentColor` so they follow the theme. */
export const ICONS = /** @type {Record<string, any[]>} */ ({
  council: [
    ['circle', { cx: 6, cy: 7, r: 2.2 }], ['circle', { cx: 12, cy: 5, r: 2.2 }], ['circle', { cx: 18, cy: 7, r: 2.2 }],
    ['path', { d: 'M6 10v6M12 8v8M18 10v6M3 13l3-2 3 2M9 11l3-2 3 2M15 13l3-2 3 2M4 21l2-5 2 5M10 21l2-5 2 5M16 21l2-5 2 5' }],
  ],
  machine: [
    ['path', { d: 'M3 18h18M3 22h18M7 18v4M11 18v4M15 18v4M19 18v4' }],
    ['circle', { cx: 12, cy: 5, r: 2.4 }], ['path', { d: 'M12 8v6M8 10l4 2 4-2M9 16l3-2 3 2' }],
  ],
  source: [['path', { d: 'M8 4L3 12l5 8M16 4l5 8-5 8M13.5 6l-3 12' }]],
  exports: [['path', { d: 'M12 3v11M7 9l5 5 5-5M4 15v5h16v-5' }]],
  gallery: [['path', { d: 'M3 4h18v16H3zM3 16l5-5 4 4 3-3 6 6' }], ['circle', { cx: 15.5, cy: 8.5, r: 1.6 }]],
  about: [['circle', { cx: 12, cy: 12, r: 8.5 }], ['path', { d: 'M12 11v6M12 7.5v.5' }]],
  hand: [['path', { d: 'M7 13V6.5a1.5 1.5 0 013 0V11M10 11V4.5a1.5 1.5 0 013 0V11M13 11V5.5a1.5 1.5 0 013 0V12M16 12V8.5a1.5 1.5 0 013 0V14c0 4-3 7-7 7s-6-2-7.5-5L3 13.5a1.6 1.6 0 012.7-1.7L7 13.5' }]],
  run: [['path', { d: 'M7 4l12 8-12 8z' }]],
  pause: [['path', { d: 'M8 4v16M16 4v16' }]],
  step: [['path', { d: 'M5 4l9 8-9 8zM18 4v16' }]],
  fast: [['path', { d: 'M3 5l8 7-8 7zM12 5l8 7-8 7z' }]],
  theme: [['circle', { cx: 12, cy: 12, r: 4 }], ['path', { d: 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1' }]],
  motion: [['path', { d: 'M4 12c2-4 4-4 6 0s4 4 6 0 3-3 4-2M4 6h2M4 18h2' }]],
  crew: [['circle', { cx: 8, cy: 6, r: 2.4 }], ['circle', { cx: 16, cy: 6, r: 2.4 }],
    ['path', { d: 'M8 9v6M16 9v6M4 12l4-2 4 2M12 12l4-2 4 2M6 21l2-6 2 6M14 21l2-6 2 6M3 3l3 3M21 3l-3 3' }]],
  board: [['path', { d: 'M3 4h18v14H3zM7 8h5v4H7zM14 11h4v4h-4zM12 10l2 3M8 21l4-3 4 3' }]],
  mail: [['path', { d: 'M3 6h18v12H3zM3 6l9 7 9-7M3 18l6-6M21 18l-6-6' }]],
  library: [['path', { d: 'M4 4h6a3 3 0 013 3v13a2 2 0 00-2-2H4zM20 4h-6a3 3 0 00-3 3M20 4v14h-7a2 2 0 00-2 2' }]],
  arcade: [['path', { d: 'M5 14h14a3 3 0 010 6H5a3 3 0 010-6zM12 14V8M8 17h2M15 17h.5' }], ['circle', { cx: 12, cy: 5.5, r: 2.6 }]],
  settings: [['circle', { cx: 12, cy: 12, r: 3 }],
    ['path', { d: 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1' }]],
  play: [['path', { d: 'M7 4l12 8-12 8z' }]],
  star: [['path', { d: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z' }]],
  speaker: [['path', { d: 'M4 9h4l5-4v14l-5-4H4zM16 8.5a5 5 0 010 7M18.5 6a8.5 8.5 0 010 12' }]],
  pin: [['path', { d: 'M9 3h6l-1 6 3 3H7l3-3zM12 12v9' }]],
  coach: [['circle', { cx: 12, cy: 6, r: 3 }], ['path', { d: 'M12 9v7M8 12l4-2 4 2M9 22l3-6 3 6M17 4l3-2M18 7h3' }]],
  stop: [['path', { d: 'M6 6h12v12H6z' }]],
  radiant: [
    ['circle', { cx: 12, cy: 12, r: 4.2 }],
    ['path', { d: 'M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1' }],
  ],
});

/** @param {string} name */
export const icon = (name) => ['svg', { class: 'os-icon', viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' }, ...ICONS[name]];

/** A plain button bound to an action.
 * @param {any} props @param {...any} children */
export const button = (props, ...children) => ['button', { type: 'button', class: 'os-btn', ...props }, ...children];

/** Render `then` only while `cond` holds. @param {any} cond @param {any} then */
export const when = (cond, then) => ({ $if: [cond, then] });

/** One status pill. @param {string} label @param {any} value */
export const pill = (label, value) => ['span', { class: 'os-pill' }, ['span', { class: 'os-pill-label' }, label], ' ', ['span', { class: 'os-pill-value' }, value]];

/** An app window's heading. @param {string} title @param {any} lead */
export const head = (title, lead) => ['header', { class: 'os-app-head' }, ['h2', {}, title], ['p', { class: 'os-app-lead' }, lead]];
