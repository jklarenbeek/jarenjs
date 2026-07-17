import { useState, useCallback, useEffect, useRef } from 'react';
import PropTypes from 'prop-types';
import { Textarea } from '@components/ui/textarea';
import { Button } from '@components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@components/ui/card';
import { Check, AlertCircle, Copy, WrapText } from 'lucide-react';
import { cn } from '@lib/utils';

/**
 * Generic JSON document editor card: local text state, live parsing,
 * format/copy actions. `value`/`revision` resync the text when the value
 * is replaced from outside (example loaded); `error` renders an external
 * (compile/runtime) error under the editor.
 */
function JsonEditor({ title, value, revision, onChange, error, minHeight = 260, actions }) {
  const [localValue, setLocalValue] = useState(() => JSON.stringify(value, null, 2));
  const [parseError, setParseError] = useState(null);
  const [copied, setCopied] = useState(false);
  const lastEmitted = useRef(value);

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

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">{title}</CardTitle>
          <div className="flex gap-1 items-center">
            {actions}
            <Button variant="ghost" size="sm" onClick={handleFormat} title="Format JSON">
              <WrapText className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={handleCopy} title="Copy">
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
            'flex-1 font-mono text-sm resize-y',
            parseError && 'border-destructive focus-visible:ring-destructive',
          )}
          style={{ minHeight }}
          spellCheck={false}
          aria-label={`${title} editor`}
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
            <span className="whitespace-pre-wrap break-words">{error}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

JsonEditor.propTypes = {
  title: PropTypes.node.isRequired,
  value: PropTypes.any,
  revision: PropTypes.number,
  onChange: PropTypes.func,
  error: PropTypes.string,
  minHeight: PropTypes.number,
  actions: PropTypes.node,
};

export { JsonEditor };
