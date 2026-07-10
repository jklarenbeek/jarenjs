import { useState, useCallback, useEffect, useRef } from 'react';
import { Textarea } from '@components/ui/textarea';
import { Button } from '@components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@components/ui/card';
import { Badge } from '@components/ui/badge';
import { Check, AlertCircle, Wand2, Copy, WrapText } from 'lucide-react';
import { cn } from '@lib/utils';

/**
 * Raw JSON data editor. Stays in sync with edits made through the
 * generated form (both views share the same data object).
 */
function DataInput({ value, revision, onChange, isValid, schema }) {
  const [localValue, setLocalValue] = useState(() => JSON.stringify(value, null, 2));
  const [parseError, setParseError] = useState(null);
  const [copied, setCopied] = useState(false);
  const lastEmitted = useRef(value);

  // Resync when the data was changed from outside (generated form,
  // example loaded, sample generated)
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
      // Clipboard unavailable
    }
  }, [localValue]);

  const generateSampleData = useCallback(() => {
    if (!schema) return;
    const sample = generateSampleFromSchema(schema, schema);
    onChange?.(sample);
  }, [schema, onChange]);

  const status = isValid === null ? 'idle' : isValid ? 'success' : 'error';

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            Data (JSON)
            {status === 'success' && (
              <Badge variant="success">
                <Check className="h-3 w-3 mr-1" />
                Valid
              </Badge>
            )}
            {status === 'error' && (
              <Badge variant="destructive">
                <AlertCircle className="h-3 w-3 mr-1" />
                Invalid
              </Badge>
            )}
          </CardTitle>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={generateSampleData}
              disabled={!schema}
              title="Generate sample data from the schema"
            >
              <Wand2 className="h-4 w-4 mr-1" />
              Sample
            </Button>
            <Button variant="ghost" size="sm" onClick={handleFormat} title="Format JSON">
              <WrapText className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="sm" onClick={handleCopy} title="Copy data">
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
            'flex-1 font-mono text-sm min-h-[300px] resize-none',
            parseError && 'border-destructive focus-visible:ring-destructive'
          )}
          placeholder="Enter your JSON data here..."
          spellCheck={false}
          aria-label="JSON data editor"
        />

        {parseError && (
          <div className="text-sm text-destructive flex items-start gap-1">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>JSON: {parseError}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Generate sample data from a schema (resolving local $refs).
 */
function generateSampleFromSchema(schema, rootSchema, depth = 0) {
  if (!schema || typeof schema !== 'object' || depth > 16) {
    return null;
  }

  if (typeof schema.$ref === 'string' && schema.$ref.startsWith('#/')) {
    const parts = schema.$ref.slice(2).split('/')
      .map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
    let target = rootSchema;
    for (const part of parts) {
      if (target == null || typeof target !== 'object') return null;
      target = target[part];
    }
    return generateSampleFromSchema(target, rootSchema, depth + 1);
  }

  if (schema.default !== undefined) return schema.default;
  if (schema.const !== undefined) return schema.const;
  if (schema.examples?.length > 0) return schema.examples[0];
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];

  switch (schema.type) {
    case 'string':
      switch (schema.format) {
        case 'email': return 'user@example.com';
        case 'date': return '2024-01-15';
        case 'time': return '13:45:30Z';
        case 'date-time': return '2024-01-15T13:45:30Z';
        case 'uri': case 'url': return 'https://example.com';
        case 'uuid': case 'guid': return '123e4567-e89b-12d3-a456-426614174000';
        case 'ipv4': return '192.168.0.1';
        case 'ipv6': return '::1';
        case 'hostname': return 'example.com';
        case 'duration': return 'P3DT4H';
        case 'iban': return 'NL91ABNA0417164300';
        default: break;
      }
      if (schema.pattern) {
        if (schema.pattern.includes('\\d{5}')) return '12345';
        if (schema.pattern.includes('\\d')) return '123';
        return 'sample';
      }
      if (schema.minLength) return 'sample'.padEnd(schema.minLength, 'x').slice(0, Math.max(schema.minLength, 6));
      return 'sample string';

    case 'number':
      if (schema.minimum !== undefined) return schema.minimum;
      if (schema.exclusiveMinimum !== undefined) return schema.exclusiveMinimum + (schema.multipleOf || 1);
      if (schema.maximum !== undefined) return schema.maximum;
      return 3.14;

    case 'integer':
      if (schema.minimum !== undefined) return schema.minimum;
      if (schema.exclusiveMinimum !== undefined) return schema.exclusiveMinimum + 1;
      if (schema.maximum !== undefined) return schema.maximum;
      return 42;

    case 'boolean':
      return true;

    case 'array': {
      const itemCount = schema.minItems || 1;
      const items = [];
      const itemSchema = Array.isArray(schema.prefixItems)
        ? null
        : (typeof schema.items === 'object' ? schema.items : null);
      if (Array.isArray(schema.prefixItems)) {
        for (const prefix of schema.prefixItems) {
          items.push(generateSampleFromSchema(prefix, rootSchema, depth + 1));
        }
      } else if (itemSchema) {
        for (let i = 0; i < itemCount; i++) {
          items.push(generateSampleFromSchema(itemSchema, rootSchema, depth + 1));
        }
      }
      return items;
    }

    case 'object': {
      const obj = {};
      if (schema.properties) {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          const sample = generateSampleFromSchema(propSchema, rootSchema, depth + 1);
          if (sample !== null || schema.required?.includes(key)) {
            obj[key] = sample;
          }
        }
      }
      return obj;
    }

    default:
      // No explicit type: try structural inference
      if (schema.properties) {
        return generateSampleFromSchema({ ...schema, type: 'object' }, rootSchema, depth + 1);
      }
      return null;
  }
}

export { DataInput };
