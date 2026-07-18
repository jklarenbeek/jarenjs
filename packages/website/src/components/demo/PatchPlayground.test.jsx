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

  it('write mode sets at a pointer target', () => {
    render(<PatchPlayground />);
    fireEvent.click(screen.getByText('Write: set at a pointer'));
    expect(screen.getByText(/"color": "blue"/)).toBeInTheDocument();
    expect(screen.getByText('OK')).toBeInTheDocument();
  });

  it('write mode falls back to every-match writers for non-singular queries', () => {
    const { container } = render(<PatchPlayground />);
    fireEvent.click(screen.getByText('Write: remove every match'));
    expect(screen.getByText('every match')).toBeInTheDocument();
    // the only book above 20 is The Lord of the Rings — gone from the result
    const result = container.querySelector('pre code');
    expect(result.textContent).not.toContain('Lord of the Rings');
    expect(result.textContent).toContain('Moby Dick');
  });

  it('write mode accepts a normalized path target', () => {
    const { container } = render(<PatchPlayground />);
    fireEvent.click(screen.getByText('Write: normalized path'));
    expect(container.querySelector('pre code').textContent).toContain('Sayings, 2nd Edition');
  });

  it('has examples covering all four modes', () => {
    const modes = new Set(patchExamples.map((e) => e.mode));
    expect(modes).toEqual(new Set(['patch', 'merge', 'write', 'diff']));
  });
});
