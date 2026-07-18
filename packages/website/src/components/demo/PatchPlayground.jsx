import { useMemo, useState } from 'react';
import {
  compileJSONPatch,
  applyMergePatch,
  createJSONPatch,
  createMergePatch,
  compileJSONPointerSetter,
  compileJSONPointerInserter,
  compileJSONPointerRemover,
  compileJSONPathSetter,
  compileJSONPathInserter,
  compileJSONPathRemover,
  JsonWriteError,
} from '@jarenjs/json';
import { equalsJson } from '@jarenjs/core/object';
import { JsonEditor } from './JsonEditor';
import { ExampleChips, TimingBadges, ResultCard, describeEngineError } from './playgroundShared';
import { Badge } from '@components/ui/badge';
import { Input } from '@components/ui/input';
import { cn } from '@lib/utils';
import { patchExamples } from '@lib/playgroundExamples';

const MODES = [
  { key: 'patch', label: 'JSON Patch' },
  { key: 'merge', label: 'Merge Patch' },
  { key: 'write', label: 'Write ops' },
  { key: 'diff', label: 'Diff' },
];

const MODE_HINTS = {
  patch: 'RFC 6902: an array of operations (add, remove, replace, move, copy, test), each addressing a JSON Pointer. Compiled once, applied copy-on-write — the input document is never touched, and a failing operation aborts the whole patch.',
  merge: 'RFC 7396: the patch looks like the document. Objects merge recursively, null deletes a member, anything else replaces. A merge that changes nothing returns the input itself — watch the badge.',
  write: 'Standalone set / insert / remove on the same copy-on-write core. The target is a JSON Pointer, a normalized path, or any JSONPath — a singular target addresses one location, anything else writes at every matched node (in reverse document order, so shifts compose). In code, setters also take updater functions like (price) => price * 1.21.',
  diff: 'Structural diff: edit the two documents and read both patch formats off the difference. The JSON Patch round-trips by construction; the merge patch cannot represent a null-valued member (RFC 7396’s documented blind spot).',
};

const WRITE_OPS = ['set', 'insert', 'remove'];

const POINTER_WRITERS = {
  set: compileJSONPointerSetter,
  insert: compileJSONPointerInserter,
  remove: compileJSONPointerRemover,
};

const PATH_WRITERS = {
  set: compileJSONPathSetter,
  insert: compileJSONPathInserter,
  remove: compileJSONPathRemover,
};

// Compile a writer for the target: pointer / singular form first; a
// non-singular JSONPath (JW0001) falls back to the every-match writers.
function compileWriter(op, target) {
  try {
    return { writer: POINTER_WRITERS[op](target), multi: false };
  } catch (err) {
    if (err instanceof JsonWriteError && err.code === 'JW0001' && target.startsWith('$'))
      return { writer: PATH_WRITERS[op](target), multi: true };
    throw err;
  }
}

/**
 * JSON Patch (RFC 6902) + JSON Merge Patch (RFC 7396) playground, plus
 * the standalone write operations: apply either patch format or a
 * single set/insert/remove copy-on-write, or diff two documents.
 */
function PatchPlayground() {
  const first = patchExamples[0];
  const [mode, setMode] = useState(first.mode);
  const [document, setDocument] = useState(first.document);
  const [patch, setPatch] = useState(first.patch);
  const [target, setTarget] = useState(patchExamples.find((e) => e.mode === 'diff').target);
  const firstWrite = patchExamples.find((e) => e.mode === 'write');
  const [writeOp, setWriteOp] = useState(firstWrite.writeOp);
  const [writeTarget, setWriteTarget] = useState(firstWrite.target);
  const [writeValue, setWriteValue] = useState(firstWrite.value);
  const [revision, setRevision] = useState(0);

  const outcome = useMemo(() => {
    try {
      if (mode === 'diff') {
        const start = performance.now();
        const jsonPatch = createJSONPatch(document, target);
        const mergePatch = createMergePatch(document, target);
        const runMs = performance.now() - start;
        const roundtrips = equalsJson(compileJSONPatch(jsonPatch)(document), target);
        return { value: { jsonPatch, mergePatch }, compileMs: null, runMs, roundtrips, error: null };
      }
      if (mode === 'merge') {
        const start = performance.now();
        const value = applyMergePatch(document, patch);
        const runMs = performance.now() - start;
        return { value, compileMs: null, runMs, shared: value === document, error: null };
      }
      if (mode === 'write') {
        const start = performance.now();
        const { writer, multi } = compileWriter(writeOp, writeTarget);
        const compileMs = performance.now() - start;
        const runStart = performance.now();
        const value = writeOp === 'remove' ? writer(document) : writer(document, writeValue);
        const runMs = performance.now() - runStart;
        return { value, compileMs, runMs, multi, shared: value === document, error: null };
      }
      const start = performance.now();
      const apply = compileJSONPatch(patch);
      const compileMs = performance.now() - start;
      const runStart = performance.now();
      const value = apply(document);
      const runMs = performance.now() - runStart;
      return { value, compileMs, runMs, error: null };
    } catch (err) {
      return { value: undefined, compileMs: null, runMs: null, error: err };
    }
  }, [mode, document, patch, target, writeOp, writeTarget, writeValue]);

  const loadExample = (example) => {
    setMode(example.mode);
    setDocument(example.document);
    if (example.mode === 'write') {
      setWriteOp(example.writeOp);
      setWriteTarget(example.target);
      if (example.value !== undefined) setWriteValue(example.value);
    }
    else {
      if (example.patch !== undefined) setPatch(example.patch);
      if (example.target !== undefined) setTarget(example.target);
    }
    setRevision((r) => r + 1);
  };

  const error = describeEngineError(outcome.error, 'Patch error');
  const isAtomicAbort = outcome.error?.name === 'JsonPatchRuntimeError';

  return (
    <div className="space-y-4">
      <ExampleChips examples={patchExamples} onLoad={loadExample} />

      <div className="flex flex-wrap gap-3 items-center">
        <div className="flex rounded-lg border overflow-hidden">
          {MODES.map((m) => (
            <button
              key={m.key}
              onClick={() => setMode(m.key)}
              className={cn(
                'px-3 py-1.5 text-sm font-medium transition-colors',
                mode === m.key ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70',
              )}
            >
              {m.label}
            </button>
          ))}
        </div>
        <p className="flex-1 min-w-64 text-xs text-muted-foreground">{MODE_HINTS[mode]}</p>
      </div>

      <div className="grid lg:grid-cols-3 gap-6 items-start">
        <JsonEditor
          title={mode === 'diff' ? 'Source document' : 'Document'}
          value={document}
          revision={revision}
          onChange={setDocument}
          minHeight={360}
        />

        {mode === 'diff' && (
          <JsonEditor
            title="Target document"
            value={target}
            revision={revision}
            onChange={setTarget}
            minHeight={360}
          />
        )}
        {(mode === 'patch' || mode === 'merge') && (
          <JsonEditor
            title={mode === 'merge' ? 'Merge patch (RFC 7396)' : 'Patch (RFC 6902)'}
            value={patch}
            revision={revision}
            onChange={setPatch}
            minHeight={360}
          />
        )}
        {mode === 'write' && (
          <div className="space-y-4">
            <div className="flex rounded-lg border overflow-hidden w-fit">
              {WRITE_OPS.map((op) => (
                <button
                  key={op}
                  onClick={() => setWriteOp(op)}
                  className={cn(
                    'px-3 py-1.5 text-sm font-medium transition-colors',
                    writeOp === op ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground hover:bg-muted/70',
                  )}
                >
                  {op}
                </button>
              ))}
            </div>
            <div className="space-y-1">
              <label htmlFor="write-target" className="text-xs font-medium text-muted-foreground">
                Target — JSON Pointer, normalized path, or JSONPath
              </label>
              <Input
                id="write-target"
                value={writeTarget}
                onChange={(e) => setWriteTarget(e.target.value)}
                className="font-mono"
                placeholder="/store/bicycle/color or $..price"
                spellCheck={false}
              />
            </div>
            {writeOp !== 'remove' && (
              <JsonEditor
                title="Value"
                value={writeValue}
                revision={revision}
                onChange={setWriteValue}
                minHeight={180}
              />
            )}
          </div>
        )}

        <ResultCard
          title={mode === 'diff' ? 'Generated patches' : mode === 'write' ? 'New document' : 'Patched document'}
          error={error}
          badges={(
            <div className="flex items-center gap-2">
              {mode === 'write' && outcome.multi && !error && (
                <Badge
                  variant="secondary"
                  title="The target is not a singular query, so the write applies at every matched node — in reverse document order, so array shifts and nested matches compose"
                >
                  every match
                </Badge>
              )}
              {(mode === 'merge' || mode === 'write') && outcome.shared && (
                <Badge
                  variant="success"
                  title="Nothing changed (for writes: the query matched nothing), so the input object itself came back (output === input) — no copy was made"
                >
                  === input (shared)
                </Badge>
              )}
              {mode === 'diff' && outcome.roundtrips && (
                <Badge
                  variant="success"
                  title="applyJSONPatch(source, createJSONPatch(source, target)) deep-equals target"
                >
                  round-trip verified
                </Badge>
              )}
              <TimingBadges compileMs={outcome.compileMs} runMs={outcome.runMs} />
            </div>
          )}
          value={error ? undefined : outcome.value}
        />
      </div>

      {isAtomicAbort && (
        <p className="text-sm text-muted-foreground">
          The patch aborted <em>atomically</em>: the error carries <code className="bg-muted px-1 rounded">docPath</code>{' '}
          (the failing operation in the patch) and <code className="bg-muted px-1 rounded">dataPath</code> (its target in
          the document), and because application is copy-on-write the input document was never touched — earlier
          operations leave nothing behind.
        </p>
      )}

      <p className="text-xs text-muted-foreground">
        {mode === 'write' ? (
          <>
            <code className="bg-muted px-1 rounded">compileJSONPointerSetter</code> and friends compile the target once —
            an RFC 6901 pointer, an RFC 9535 normalized path, or any singular query (negative indexes included) all
            work, and non-singular queries switch to the every-match writers. Application is the same copy-on-write core
            as JSON Patch: only the written spine is cloned, everything else is shared, and failures
            (<code className="bg-muted px-1 rounded">JsonWriteError</code> with a stable code and{' '}
            <code className="bg-muted px-1 rounded">dataPath</code>) leave the input untouched.
          </>
        ) : (
          <>
            <code className="bg-muted px-1 rounded">compileJSONPatch</code> validates the patch once, pre-parses every
            pointer and specializes one closure per operation; applying clones only the spine it writes through — and
            clones it once, no matter how many operations touch the same region. Untouched subtrees are shared with the
            result, which is why applying is 5–170× faster than the usual clone-and-interpret shape. The engine passes all
            108 official json-patch-tests vectors; see the Benchmarks tab for the numbers.
          </>
        )}
      </p>
    </div>
  );
}

export { PatchPlayground };
