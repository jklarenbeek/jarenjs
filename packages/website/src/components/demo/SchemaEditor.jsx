import { useState, useCallback } from 'react';
import { Textarea } from '@components/ui/textarea';
import { Button } from '@components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@components/ui/card';
import { Badge } from '@components/ui/badge';
import { Check, AlertCircle, Play } from 'lucide-react';
import { cn } from '@lib/utils';

const exampleSchemas = {
  simple: {
    name: 'Simple Object',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1 },
        age: { type: 'integer', minimum: 0 },
        email: { type: 'string', format: 'email' },
      },
      required: ['name', 'age'],
    },
  },
  user: {
    name: 'User Profile',
    schema: {
      type: 'object',
      properties: {
        username: { type: 'string', pattern: '^[a-zA-Z0-9_]+$' },
        email: { type: 'string', format: 'email' },
        age: { type: 'integer', minimum: 13, maximum: 120 },
        active: { type: 'boolean' },
        role: { type: 'string', enum: ['user', 'admin', 'moderator'] },
      },
      required: ['username', 'email'],
    },
  },
  product: {
    name: 'Product',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string', minLength: 1, maxLength: 100 },
        price: { type: 'number', minimum: 0 },
        tags: {
          type: 'array',
          items: { type: 'string' },
        },
        inStock: { type: 'boolean' },
      },
      required: ['id', 'name', 'price'],
    },
  },
  nested: {
    name: 'Nested Object',
    schema: {
      type: 'object',
      properties: {
        user: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            address: {
              type: 'object',
              properties: {
                street: { type: 'string' },
                city: { type: 'string' },
                zipCode: { type: 'string', pattern: '^\\d{5}$' },
              },
              required: ['street', 'city'],
            },
          },
          required: ['name'],
        },
      },
      required: ['user'],
    },
  },
};

function SchemaEditor({ value, onChange, onCompile, isValid, error }) {
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

  const handleCompile = useCallback(() => {
    try {
      const parsed = JSON.parse(localValue);
      onCompile?.(parsed);
    } catch (err) {
      setParseError(err.message);
    }
  }, [localValue, onCompile]);

  const loadExample = useCallback((key) => {
    const example = exampleSchemas[key];
    if (example) {
      const json = JSON.stringify(example.schema, null, 2);
      setLocalValue(json);
      setParseError(null);
      onChange?.(example.schema);
    }
  }, [onChange]);

  const hasError = parseError || error;
  const status = isValid ? 'success' : hasError ? 'error' : 'idle';

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            JSON Schema
            {status === 'success' && (
              <Badge variant="success" className="ml-2">
                <Check className="h-3 w-3 mr-1" />
                Valid
              </Badge>
            )}
            {status === 'error' && (
              <Badge variant="destructive" className="ml-2">
                <AlertCircle className="h-3 w-3 mr-1" />
                Error
              </Badge>
            )}
          </CardTitle>
          <Button 
            size="sm" 
            onClick={handleCompile}
            disabled={!!parseError}
          >
            <Play className="h-4 w-4 mr-1" />
            Compile
          </Button>
        </div>
        
        {/* Example Selector */}
        <div className="flex flex-wrap gap-2 mt-2">
          <span className="text-xs text-muted-foreground self-center">Examples:</span>
          {Object.entries(exampleSchemas).map(([key, { name }]) => (
            <button
              key={key}
              onClick={() => loadExample(key)}
              className="text-xs px-2 py-1 rounded bg-muted hover:bg-muted/80 transition-colors"
            >
              {name}
            </button>
          ))}
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
          placeholder="Enter your JSON schema here..."
          spellCheck={false}
        />
        
        {parseError && (
          <div className="text-sm text-destructive flex items-center gap-1">
            <AlertCircle className="h-4 w-4" />
            {parseError}
          </div>
        )}
        
        {error && !parseError && (
          <div className="text-sm text-destructive flex items-center gap-1">
            <AlertCircle className="h-4 w-4" />
            {error}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export { SchemaEditor, exampleSchemas };
