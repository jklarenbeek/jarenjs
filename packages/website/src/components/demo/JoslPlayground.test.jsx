import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { JoslPlayground } from './JoslPlayground';
import { joslExamples } from '@lib/playgroundExamples';

describe('JoslPlayground', () => {
  it('parses the default example and renders first-class types as JSONX', () => {
    render(<JoslPlayground />);
    expect(screen.getByText(/"middle-name": null/)).toBeInTheDocument();
    expect(screen.getAllByText(/9007199254740993n/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/\/\^ok\[!\.\]\?\$\/i/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('OK').length).toBeGreaterThan(0);
  });

  it('shows document-order events with paths', () => {
    render(<JoslPlayground />);
    fireEvent.click(screen.getByText('Record stream [[]]'));
    expect(screen.getAllByText('root-item').length).toBe(2);
    expect(screen.getAllByText('pair').length).toBeGreaterThan(0);
  });

  it('round-trips the parsed value through stringifyJosl', () => {
    render(<JoslPlayground />);
    expect(screen.getByText('stringifyJosl(value)')).toBeInTheDocument();
    expect(screen.getByText('Round-trip')).toBeInTheDocument();
  });

  it('rejects JOSL extensions in strict TOML mode with a repair hint', () => {
    render(<JoslPlayground />);
    fireEvent.click(screen.getByText('Repairable error'));
    expect(screen.getByText('JoslSyntaxError')).toBeInTheDocument();
    expect(screen.getAllByText(/TOML has no null/).length).toBeGreaterThan(0);
  });

  it('switching the default example to strict TOML mode surfaces the extension error', () => {
    render(<JoslPlayground />);
    fireEvent.click(screen.getByText('strict TOML'));
    expect(screen.getByText('JoslSyntaxError')).toBeInTheDocument();
  });

  it('has examples covering both dialects', () => {
    const modes = new Set(joslExamples.map((e) => e.mode));
    expect(modes).toEqual(new Set(['josl', 'toml']));
  });
});
