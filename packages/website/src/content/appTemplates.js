//@ts-check
/**
 * The Studio seed library: three complete, boot-tested `@jarenjs/app`
 * documents. They are the few-shot corpus the assistant adapts from
 * (author via template + patch, never from scratch), so each one is a
 * small but honest application: state + JSLT view + actions as one
 * JSON value, rendered through the studio's widget capabilities.
 *
 * Everything exported here is PLAIN JSON — `createFormActions` is a
 * factory that returns action documents as data, so the form template
 * stays a pure document.
 */

import { createFormActions } from '@jarenjs/app';

const FORM_TEMPLATE = {
  $app: '0.1',
  state: {
    schema: {
      type: 'object',
      title: 'Register',
      properties: {
        name: { type: 'string', minLength: 2, description: 'Your full name.' },
        email: { type: 'string', format: 'email' },
        age: { type: 'integer', minimum: 13 },
        newsletter: { type: 'boolean' },
        plan: { enum: ['free', 'pro'] },
      },
      required: ['name', 'email'],
    },
    data: { name: '', email: '', newsletter: true, plan: 'free' },
  },
  view: {
    $jslt: '0.1',
    rules: [
      {
        match: '$',
        body: ['div', { class: 'studio-app' },
          ['h2', {}, 'Create your account'],
          ['p', { class: 'studio-app-lead' },
            'A schema-driven registration form: the JSON Schema lives in this document’s state, the form widget renders it through the standard forms stylesheet, and every keystroke validates live.'],
          ['jaren-widget', { name: 'form', props: { schema: '$.schema', data: '$.data' } }],
        ],
      },
    ],
  },
  actions: {
    // the standard form actions write user input back into /data
    ...createFormActions({ dataPointer: '/data' }),
  },
};

const barChart = (title, values) => ({
  type: 'bar',
  title,
  valLabel: 'k€',
  categories: ['Q1', 'Q2', 'Q3', 'Q4'],
  series: [{ name: 'revenue', values }],
});

const pieChart = (title, slices) => ({ type: 'pie', title, slices });

const DASHBOARD_TEMPLATE = {
  $app: '0.1',
  state: {
    region: 'eu',
    series: {
      eu: {
        revenue: barChart('Revenue — Europe', [120, 138, 151, 164]),
        share: pieChart('Channel share — Europe', [
          { label: 'direct', value: 44 },
          { label: 'partner', value: 31 },
          { label: 'online', value: 25 },
        ]),
      },
      us: {
        revenue: barChart('Revenue — Americas', [98, 104, 121, 140]),
        share: pieChart('Channel share — Americas', [
          { label: 'direct', value: 29 },
          { label: 'partner', value: 22 },
          { label: 'online', value: 49 },
        ]),
      },
    },
    revenue: barChart('Revenue — Europe', [120, 138, 151, 164]),
    share: pieChart('Channel share — Europe', [
      { label: 'direct', value: 44 },
      { label: 'partner', value: 31 },
      { label: 'online', value: 25 },
    ]),
  },
  view: {
    $jslt: '0.1',
    rules: [
      {
        match: '$',
        body: ['div', { class: 'studio-app' },
          ['h2', {}, 'Quarterly dashboard'],
          ['label', { class: 'studio-app-control' },
            'Region ',
            ['select', { on: { change: 'pick' } },
              ['option', { value: 'eu', selected: { $eq: ['$.region', 'eu'] } }, 'Europe'],
              ['option', { value: 'us', selected: { $eq: ['$.region', 'us'] } }, 'Americas'],
            ],
          ],
          ['div', { class: 'studio-app-panels' },
            ['jaren-widget', { name: 'chart', props: { config: '$.revenue' } }],
            ['jaren-widget', { name: 'chart', props: { config: '$.share' } }],
          ],
        ],
      },
    ],
  },
  actions: {
    // the select filters the panels: one action swaps both chart
    // definitions from the per-region series in state
    pick: {
      patch: [
        { op: 'replace', path: '/region', value: '$event.value' },
        {
          op: 'replace',
          path: '/revenue',
          value: { $if: [{ $eq: ['$event.value', 'us'] }, '$.series.us.revenue', '$.series.eu.revenue'] },
        },
        {
          op: 'replace',
          path: '/share',
          value: { $if: [{ $eq: ['$event.value', 'us'] }, '$.series.us.share', '$.series.eu.share'] },
        },
      ],
    },
  },
};

const MINISITE_TEMPLATE = {
  $app: '0.1',
  state: {
    page: 'home',
    pages: {
      home: [
        '# Wavelength Coffee',
        '',
        'Small-batch roasting on the canal since 2019. Every bag ships',
        'within **48 hours** of roasting.',
        '',
        '- Espresso blends and single origins',
        '- Subscriptions with free delivery',
        '- Workshops every first Saturday',
      ].join('\n'),
      about: [
        '## How an order flows',
        '',
        'From the roaster to your door, as a diagram:',
        '',
        '```mermaid',
        'flowchart LR',
        '  A[Order placed] --> B[Roast batch]',
        '  B --> C{Quality check}',
        '  C -->|pass| D[Ship within 48h]',
        '  C -->|fail| B',
        '```',
        '',
        'The diagram renders through the same headless Mermaid engine',
        'as the rest of this site.',
      ].join('\n'),
    },
  },
  view: {
    $jslt: '0.1',
    rules: [
      {
        match: '$',
        body: ['div', { class: 'studio-app' },
          ['nav', { class: 'studio-app-nav' },
            ['button', {
              type: 'button',
              class: { $if: [{ $eq: ['$.page', 'home'] }, 'studio-app-link active', 'studio-app-link'] },
              on: { click: { action: 'go', with: 'home' } },
            }, 'Home'],
            ['button', {
              type: 'button',
              class: { $if: [{ $eq: ['$.page', 'about'] }, 'studio-app-link active', 'studio-app-link'] },
              on: { click: { action: 'go', with: 'about' } },
            }, 'About'],
          ],
          ['jaren-widget', {
            name: 'markdown',
            props: {
              source: { $if: [{ $eq: ['$.page', 'about'] }, '$.pages.about', '$.pages.home'] },
            },
          }],
        ],
      },
    ],
  },
  actions: {
    go: { patch: [{ op: 'replace', path: '/page', value: '$payload' }] },
  },
};

/** The seed templates, in picker order. */
export const STUDIO_TEMPLATES = [
  {
    name: 'form',
    title: 'Form + validation',
    lead: 'A registration form over the standard forms stylesheet: the JSON Schema lives in state, every field validates live.',
    doc: FORM_TEMPLATE,
  },
  {
    name: 'dashboard',
    title: 'Dashboard',
    lead: 'State-driven @jarenjs/charts panels with a select that filters the data — one action swaps both chart definitions.',
    doc: DASHBOARD_TEMPLATE,
  },
  {
    name: 'minisite',
    title: 'Mini-site',
    lead: 'Two routed pages of @jarenjs/md content, including a Mermaid diagram rendered by the headless engine.',
    doc: MINISITE_TEMPLATE,
  },
];

/**
 * Look a template up by name.
 * @param {string} name
 */
export function studioTemplate(name) {
  return STUDIO_TEMPLATES.find((t) => t.name === name);
}
