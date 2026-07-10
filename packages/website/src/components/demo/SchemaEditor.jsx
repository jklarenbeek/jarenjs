import { useState, useCallback, useEffect, useRef } from 'react';
import { Textarea } from '@components/ui/textarea';
import { Button } from '@components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@components/ui/card';
import { Badge } from '@components/ui/badge';
import { Check, AlertCircle, Copy, WrapText } from 'lucide-react';
import { cn } from '@lib/utils';

/**
 * JSON Schema editor with live parsing. Compilation happens automatically
 * (debounced) in the parent whenever the parsed schema changes.
 */
function SchemaEditor({ value, revision, onChange, isValid, error }) {
  const [localValue, setLocalValue] = useState(() => JSON.stringify(value, null, 2));
  const [parseError, setParseError] = useState(null);
  const [copied, setCopied] = useState(false);
  const lastEmitted = useRef(value);

  // Resync the text when the schema was changed from outside
  // (example loaded, playground reset)
  useEffect(() => {
    if (value !== lastEmitted.current) {
      setLocalValue(JSON.stringify(value, null, 2));
      setParseError(null);
      lastEmitted.current = value;
    }
  }, [value, revision]);

  const handleChange = useCallback((e) => {
    const newValue = e.target.value;
    setLocalValue(newValue);

    try {
      const parsed = JSON.parse(newValue);
      setParseError(null);
      lastEmitted.current = parsed;
      onChange?.(parsed);
    } catch (err) {
      setParseError(err.message);
    }
  }, [onChange]);

  const handleFormat = useCallback(() => {
    try {
      setLocalValue(JSON.stringify(JSON.parse(localValue), null, 2));
      setParseError(null);
    } catch (err) {
      setParseError(err.message);
    }
  }, [localValue]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(localValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable; nothing sensible to do
    }
  }, [localValue]);

  const hasError = parseError || error;
  const status = hasError ? 'error' : isValid ? 'success' : 'idle';

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            JSON Schema
            {status === 'success' && (
              <Badge variant="success">
                <Check className="h-3 w-3 mr-1" />
                Compiled
              </Badge>
            )}
            {status === 'error' && (
              <Badge variant="destructive">
                <AlertCircle className="h-3 w-3 mr-1" />
                Error
              </Badge>
            )}
          </CardTitle>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={handleFormat} title="Format JSON">
              <WrapText className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={handleCopy} title="Copy schema">
              {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex-1 flex flex-col gap-3">
        <Textarea
          value={localValue}
          onChange={handleChange}
          className={cn(
            'flex-1 font-mono text-sm min-h-[420px] resize-none',
            parseError && 'border-destructive focus-visible:ring-destructive'
          )}
          placeholder="Enter your JSON schema here..."
          spellCheck={false}
          aria-label="JSON Schema editor"
        />

        {parseError && (
          <div className="text-sm text-destructive flex items-start gap-1">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>JSON: {parseError}</span>
          </div>
        )}

        {error && !parseError && (
          <div className="text-sm text-destructive flex items-start gap-1">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>Compile: {error}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export { SchemaEditor };
