//@ts-check
import { describe, it } from 'node:test';
import assert from 'node:assert';

import { resolveTheme } from '@jarenjs/view/helpers';

const THEMES = {
  default: { background: 'transparent', axis: '#64748b', fontFamily: 'F' },
  dark: { background: 'transparent', axis: '#94a3b8', fontFamily: 'F' },
};

describe('view/helpers — resolveTheme', () => {
  it('resolves a named theme and stamps prefixed, kebab-cased cssVars', () => {
    const r = resolveTheme(THEMES, 'calc', 'default');
    assert.equal(r.name, 'default');
    assert.deepEqual(r.tokens, { background: 'transparent', axis: '#64748b', fontFamily: 'F' });
    assert.deepEqual(r.cssVars, {
      '--calc-background': 'transparent',
      '--calc-axis': '#64748b',
      '--calc-font-family': 'F',
    });
  });

  it('honours the caller prefix', () => {
    const r = resolveTheme(THEMES, 'mm', 'dark');
    assert.equal(r.name, 'dark');
    assert.equal(r.cssVars['--mm-axis'], '#94a3b8');
  });

  it('falls back to default for an unknown name', () => {
    const r = resolveTheme(THEMES, 'calc', 'nope');
    assert.equal(r.name, 'default');
    assert.equal(r.tokens.axis, '#64748b');
  });

  it('defaults the argument to "default"', () => {
    const r = resolveTheme(THEMES, 'calc');
    assert.equal(r.name, 'default');
  });

  it('merges an overrides object and can name a base via its theme key', () => {
    const r = resolveTheme(THEMES, 'mm', { theme: 'dark', axis: '#fff' });
    assert.equal(r.name, 'dark');
    assert.equal(r.tokens.axis, '#fff');
    // preserves the historical behaviour: the whole overrides object is
    // merged, so a `theme` key leaks into tokens/cssVars
    assert.equal(r.cssVars['--mm-theme'], 'dark');
  });

  it('links tokens to host custom properties via the reserved vars key', () => {
    const r = resolveTheme(THEMES, 'mm', { vars: { axis: '--muted' } });
    // tokens stay concrete (presentation attributes remain standalone-valid)
    assert.equal(r.tokens.axis, '#64748b');
    assert.equal(r.tokens.vars, undefined);
    // the linked cssVar follows the host token, concrete value as fallback
    assert.equal(r.cssVars['--mm-axis'], 'var(--muted, #64748b)');
    // unlinked tokens stamp unchanged, and vars itself never stamps
    assert.equal(r.cssVars['--mm-background'], 'transparent');
    assert.equal(r.cssVars['--mm-vars'], undefined);
  });

  it('composes vars with a named base and plain overrides', () => {
    const r = resolveTheme(THEMES, 'calc', { theme: 'dark', background: '#000', vars: { axis: '--muted' } });
    assert.equal(r.name, 'dark');
    assert.equal(r.cssVars['--calc-axis'], 'var(--muted, #94a3b8)');
    assert.equal(r.cssVars['--calc-background'], '#000');
  });
});
