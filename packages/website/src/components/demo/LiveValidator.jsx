import { useState, useCallback, useEffect, useMemo } from 'react';
import { SchemaEditor } from './SchemaEditor';
import { DataInput } from './DataInput';
import { ValidationResult } from './ValidationResult';
import { SchemaForm } from './SchemaForm';
import { useJarenValidator, detectDraftName } from '@hooks/useJarenValidator';
import { useLocalStorage } from '@hooks/useLocalStorage';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@components/ui/tabs';
import { Badge } from '@components/ui/badge';
import { Button } from '@components/ui/button';
import { setValueAtPointer } from '@jarenjs/forms';
import { exampleSchemas } from '@lib/examples';
import { RotateCcw, Share2, Check } from 'lucide-react';

const DEFAULT_EXAMPLE = 'user';

function readShareLink() {
  try {
    const match = window.location.hash.match(/[?&]s=([^&]+)/);
    if (!match) return null;
    const decoded = JSON.parse(atob(decodeURIComponent(match[1])));
    if (decoded && typeof decoded === 'object' && decoded.schema !== undefined) {
      return decoded;
    }
  } catch {
    // Malformed share payloads fall back to the stored/default state
  }
  return null;
}

function LiveValidator() {
  const shared = useMemo(readShareLink, []);
  const [stored, setStored] = useLocalStorage('jaren-playground', null);

  const initial = shared || stored || {
    schema: exampleSchemas[DEFAULT_EXAMPLE].schema,
    data: exampleSchemas[DEFAULT_EXAMPLE].data,
  };

  const [schema, setSchema] = useState(initial.schema);
  const [data, setData] = useState(initial.data);
  const [activeTab, setActiveTab] = useState('form');
  const [copied, setCopied] = useState(false);
  // Bumped when an example is loaded / share reset, so the editors resync
  const [revision, setRevision] = useState(0);

  const {
    compileSchema,
    validate,
    errors,
    isValid,
    compileError,
    compiled,
    stats,
  } = useJarenValidator();

  // Compile (debounced) whenever the schema changes
  useEffect(() => {
    const timer = setTimeout(() => compileSchema(schema), 250);
    return () => clearTimeout(timer);
  }, [schema, compileSchema]);

  // Re-validate whenever the data or the compiled schema changes
  useEffect(() => {
    if (compiled) validate(data);
  }, [data, compiled, validate]);

  // Persist to localStorage
  useEffect(() => {
    const timer = setTimeout(() => setStored({ schema, data }), 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schema, data]);

  const handleFormChange = useCallback((pointer, value) => {
    setData((prev) => setValueAtPointer(prev, pointer, value));
  }, []);

  const loadExample = useCallback((key) => {
    const example = exampleSchemas[key];
    if (!example) return;
    setSchema(example.schema);
    setData(example.data ?? {});
    setRevision((r) => r + 1);
  }, []);

  const handleReset = useCallback(() => {
    loadExample(DEFAULT_EXAMPLE);
  }, [loadExample]);

  const handleShare = useCallback(async () => {
    const payload = encodeURIComponent(btoa(JSON.stringify({ schema, data })));
    const url = `${window.location.origin}${window.location.pathname}#/playground?s=${payload}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt('Copy this playground link:', url);
    }
  }, [schema, data]);

  const draftName = detectDraftName(schema);

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Examples:</span>
        {Object.entries(exampleSchemas).map(([key, { name }]) => (
          <button
            key={key}
            onClick={() => loadExample(key)}
            className="text-xs px-2.5 py-1 rounded-full bg-muted hover:bg-primary/10 hover:text-primary transition-colors"
          >
            {name}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <Badge variant="secondary" title="Detected from $schema">{draftName}</Badge>
          {stats.compileMs != null && (
            <Badge variant="outline" title="Schema compile time">
              compile {stats.compileMs.toFixed(1)}ms
            </Badge>
          )}
          {stats.validateMs != null && (
            <Badge variant="outline" title="Validation time">
              validate {stats.validateMs < 0.1 ? '<0.1' : stats.validateMs.toFixed(1)}ms
            </Badge>
          )}
          <Button variant="ghost" size="sm" onClick={handleShare} title="Copy a shareable link">
            {copied ? <Check className="h-4 w-4 text-success" /> : <Share2 className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={handleReset} title="Reset playground">
            <RotateCcw className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* Left Column - Schema */}
        <SchemaEditor
          value={schema}
          revision={revision}
          onChange={setSchema}
          isValid={compiled}
          error={compileError}
        />

        {/* Right Column - Data & Results */}
        <div className="space-y-6">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="w-full">
              <TabsTrigger value="form" className="flex-1">Generated Form</TabsTrigger>
              <TabsTrigger value="json" className="flex-1">JSON Data</TabsTrigger>
            </TabsList>

            <TabsContent value="form" className="mt-4">
              <SchemaForm
                schema={schema}
                value={data}
                onChange={handleFormChange}
                errors={errors}
              />
            </TabsContent>

            <TabsContent value="json" className="mt-4">
              <DataInput
                value={data}
                revision={revision}
                onChange={setData}
                isValid={isValid}
                schema={schema}
              />
            </TabsContent>
          </Tabs>

          <ValidationResult
            isValid={isValid}
            errors={errors}
            compileError={compileError}
          />
        </div>
      </div>
    </div>
  );
}

export { LiveValidator };
