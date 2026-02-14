import { useState, useCallback } from 'react';
import { Textarea } from '@components/ui/textarea';
import { Button } from '@components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@components/ui/card';
import { Badge } from '@components/ui/badge';
import { Check, AlertCircle, Play, Wand2 } from 'lucide-react';
import { cn } from '@lib/utils';

function DataInput({ value, onChange, onValidate, isValid, error, schema }) {
  const [localValue, setLocalValue] = useState(() => JSON.stringify(value, null, 2));
  const [parseError, setParseError] = useState(null);

  const handleChange = useCallback((e) => {
    const newValue = e.target.value;
    setLocalValue(newValue);
    
    try {
      const parsed = JSON.parse(newValue);
      setParseError(null);
      onChange?.(parsed);
    } catch (err) {
      setParseError(err.message);
    }
  }, [onChange]);

  const handleValidate = useCallback(() => {
    try {
      const parsed = JSON.parse(localValue);
      onValidate?.(parsed);
    } catch (err) {
      setParseError(err.message);
    }
  }, [localValue, onValidate]);

  const generateSampleData = useCallback(() => {
    if (!schema) return;
    
    const sample = generateSampleFromSchema(schema);
    const json = JSON.stringify(sample, null, 2);
    setLocalValue(json);
    setParseError(null);
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
              <Badge variant="success" className="ml-2">
                <Check className="h-3 w-3 mr-1" />
                Valid
              </Badge>
            )}
            {status === 'error' && (
              <Badge variant="destructive" className="ml-2">
                <AlertCircle className="h-3 w-3 mr-1" />
                Invalid
              </Badge>
            )}
          </CardTitle>
          <div className="flex gap-2">
            <Button 
              variant="outline" 
              size="sm" 
              onClick={generateSampleData}
              disabled={!schema}
            >
              <Wand2 className="h-4 w-4 mr-1" />
              Generate
            </Button>
            <Button 
              size="sm" 
              onClick={handleValidate}
              disabled={!!parseError}
            >
              <Play className="h-4 w-4 mr-1" />
              Validate
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
        />
        
        {parseError && (
          <div className="text-sm text-destructive flex items-center gap-1">
            <AlertCircle className="h-4 w-4" />
            {parseError}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Generate sample data from a schema
 * @param {Object} schema - JSON Schema
 * @returns {*} - Sample data
 */
function generateSampleFromSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return null;
  }

  // Handle default
  if (schema.default !== undefined) {
    return schema.default;
  }

  // Handle const
  if (schema.const !== undefined) {
    return schema.const;
  }

  // Handle enum
  if (schema.enum && schema.enum.length > 0) {
    return schema.enum[0];
  }

  // Handle type
  switch (schema.type) {
    case 'string':
      if (schema.format === 'email') return 'user@example.com';
      if (schema.format === 'date') return new Date().toISOString().split('T')[0];
      if (schema.format === 'date-time') return new Date().toISOString();
      if (schema.format === 'uri' || schema.format === 'url') return 'https://example.com';
      if (schema.pattern) {
        // Try to generate from pattern
        if (schema.pattern.includes('\\d')) return '12345';
        return 'sample';
      }
      if (schema.minLength) return 'a'.repeat(schema.minLength);
      return 'sample string';

    case 'number':
    case 'integer':
      if (schema.minimum !== undefined) return schema.minimum;
      if (schema.maximum !== undefined) return schema.maximum;
      return schema.type === 'integer' ? 42 : 3.14;

    case 'boolean':
      return true;

    case 'array':
      const itemCount = schema.minItems || 1;
      const items = [];
      for (let i = 0; i < itemCount; i++) {
        items.push(generateSampleFromSchema(schema.items));
      }
      return items;

    case 'object':
      const obj = {};
      if (schema.properties) {
        for (const [key, propSchema] of Object.entries(schema.properties)) {
          obj[key] = generateSampleFromSchema(propSchema);
        }
      }
      return obj;

    default:
      return null;
  }
}

export { DataInput };
