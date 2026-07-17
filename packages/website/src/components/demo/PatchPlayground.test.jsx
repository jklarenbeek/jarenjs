import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PatchPlayground } from './PatchPlayground';
import { patchExamples } from '@lib/playgroundExamples';

describe('PatchPlayground', () => {
  it('applies the default RFC 6902 example and shows the patched document', () => {
    render(<PatchPlayground />);
    // the default example replaces /baz with 'boo' and appends 4 to /numbers
    const result = screen.getByText(/"baz": "boo"/);
    expect(result).toBeInTheDocument();
    expect(screen.getByText('OK')).toBeInTheDocument();
  });

  it('shows the shared-identity badge on a no-op merge', () => {
    render(<PatchPlayground />);
    fireEvent.click(screen.getByText('Merge: no-op (shared)'));
    expect(screen.getByText('=== input (shared)')).toBeInTheDocument();
  });

  it('reports an atomic abort with docPath and dataPath on a failing test op', () => {
    render(<PatchPlayground />);
    fireEvent.click(screen.getByText('Atomic abort (failing test)'));
    expect(screen.getByText('JP2004')).toBeInTheDocument();
    expect(screen.getByText(/docPath: \/1/)).toBeInTheDocument();
    expect(screen.getByText(/dataPath: \/version/)).toBeInTheDocument();
  });

  it('diff mode emits both patch formats and verifies the round-trip', () => {
    render(<PatchPlayground />);
    fireEvent.click(screen.getByText('Diff two documents'));
    expect(screen.getByText('round-trip verified')).toBeInTheDocument();
    expect(screen.getByText(/"jsonPatch"/)).toBeInTheDocument();
    expect(screen.getByText(/"mergePatch"/)).toBeInTheDocument();
  });

  it('has examples covering all three modes', () => {
    const modes = new Set(patchExamples.map((e) => e.mode));
    expect(modes).toEqual(new Set(['patch', 'merge', 'diff']));
  });
});
