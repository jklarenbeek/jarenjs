import { useMemo } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@components/ui/card';
import { Input } from '@components/ui/input';
import { Textarea } from '@components/ui/textarea';
import { Select } from '@components/ui/select';
import { Badge } from '@components/ui/badge';
import { generateFormFields, getFieldType, getDefaultValue } from '@lib/schemaFormGenerator';
import { AlertCircle } from 'lucide-react';
import { cn } from '@lib/utils';

function SchemaForm({ schema, value, onChange, errors }) {
  const fields = useMemo(() => {
    return generateFormFields(schema);
  }, [schema]);

  if (!schema || schema.type !== 'object') {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>Schema must be an object type to generate a form</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg">Generated Form</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {fields.map((field) => (
          <FormField
            key={field.path}
            field={field}
            value={getNestedValue(value, field.path)}
            onChange={(newValue) => onChange?.(field.path, newValue)}
            error={getFieldError(errors, field.path)}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function FormField({ field, value, onChange, error }) {
  const { name, schema: fieldSchema, required, type, children } = field;
  const displayValue = value !== undefined ? value : getDefaultValue(type);

  const renderInput = () => {
    switch (type) {
      case 'text':
      case 'email':
      case 'url':
      case 'password':
        return (
          <Input
            type={type === 'password' ? 'password' : type === 'email' ? 'email' : 'text'}
            value={displayValue}
            onChange={(e) => onChange?.(e.target.value)}
            placeholder={fieldSchema.description || `Enter ${name}`}
          />
        );

      case 'textarea':
        return (
          <Textarea
            value={displayValue}
            onChange={(e) => onChange?.(e.target.value)}
            placeholder={fieldSchema.description || `Enter ${name}`}
            rows={4}
          />
        );

      case 'number':
      case 'integer':
        return (
          <Input
            type="number"
            value={displayValue}
            onChange={(e) => {
              const val = e.target.value === '' ? '' : Number(e.target.value);
              onChange?.(val);
            }}
            min={fieldSchema.minimum}
            max={fieldSchema.maximum}
            step={type === 'integer' ? 1 : 'any'}
            placeholder={fieldSchema.description || `Enter ${name}`}
          />
        );

      case 'checkbox':
        return (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={!!displayValue}
              onChange={(e) => onChange?.(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary"
            />
            <span className="text-sm">{fieldSchema.description || name}</span>
          </label>
        );

      case 'enum':
        return (
          <Select
            value={String(displayValue)}
            onChange={(e) => onChange?.(e.target.value)}
          >
            <option value="">Select {name}...</option>
            {fieldSchema.enum.map((option) => (
              <option key={String(option)} value={String(option)}>
                {String(option)}
              </option>
            ))}
          </Select>
        );

      case 'const':
        return (
          <Input
            value={fieldSchema.const}
            disabled
            className="bg-muted"
          />
        );

      case 'date':
        return (
          <Input
            type="date"
            value={displayValue}
            onChange={(e) => onChange?.(e.target.value)}
          />
        );

      case 'object':
        if (children && children.length > 0) {
          return (
            <div className="pl-4 border-l-2 border-muted space-y-3">
              {children.map((childField) => (
                <FormField
                  key={childField.path}
                  field={childField}
                  value={getNestedValue(value, childField.name)}
                  onChange={(newValue) => {
                    const newObj = { ...(value || {}) };
                    newObj[childField.name] = newValue;
                    onChange?.(newObj);
                  }}
                  error={error}
                />
              ))}
            </div>
          );
        }
        return (
          <Textarea
            value={JSON.stringify(displayValue, null, 2)}
            onChange={(e) => {
              try {
                onChange?.(JSON.parse(e.target.value));
              } catch {
                // Ignore invalid JSON
              }
            }}
            placeholder="Enter JSON object"
            rows={4}
            className="font-mono text-xs"
          />
        );

      case 'array':
        return (
          <ArrayField
            value={displayValue || []}
            onChange={onChange}
            itemSchema={fieldSchema.items}
          />
        );

      default:
        return (
          <Input
            value={String(displayValue)}
            onChange={(e) => onChange?.(e.target.value)}
            placeholder={fieldSchema.description || `Enter ${name}`}
          />
        );
    }
  };

  return (
    <div className="space-y-1">
      <label className="text-sm font-medium flex items-center gap-2">
        {name}
        {required && <Badge variant="destructive" className="text-[10px] px-1 py-0">Required</Badge>}
      </label>
      {fieldSchema.description && type !== 'checkbox' && (
        <p className="text-xs text-muted-foreground">{fieldSchema.description}</p>
      )}
      <div className={cn(error && '[&_input]:border-destructive [&_textarea]:border-destructive')}>
        {renderInput()}
      </div>
      {error && (
        <p className="text-xs text-destructive flex items-center gap-1">
          <AlertCircle className="h-3 w-3" />
          {error}
        </p>
      )}
      {fieldSchema.type && (
        <p className="text-xs text-muted-foreground">
          Type: <code className="bg-muted px-1 rounded">{fieldSchema.type}</code>
          {fieldSchema.format && <span>, Format: <code className="bg-muted px-1 rounded">{fieldSchema.format}</code></span>}
        </p>
      )}
    </div>
  );
}

function ArrayField({ value, onChange, itemSchema }) {
  const addItem = () => {
    const newItem = getDefaultValue(getFieldType(itemSchema));
    onChange?.([...value, newItem]);
  };

  const removeItem = (index) => {
    const newValue = [...value];
    newValue.splice(index, 1);
    onChange?.(newValue);
  };

  const updateItem = (index, newItemValue) => {
    const newValue = [...value];
    newValue[index] = newItemValue;
    onChange?.(newValue);
  };

  return (
    <div className="space-y-2">
      {value.map((item, index) => (
        <div key={index} className="flex items-start gap-2">
          <div className="flex-1">
            {itemSchema.type === 'string' ? (
              <Input
                value={item}
                onChange={(e) => updateItem(index, e.target.value)}
                placeholder={`Item ${index + 1}`}
              />
            ) : itemSchema.type === 'number' || itemSchema.type === 'integer' ? (
              <Input
                type="number"
                value={item}
                onChange={(e) => updateItem(index, Number(e.target.value))}
                placeholder={`Item ${index + 1}`}
              />
            ) : (
              <Input
                value={JSON.stringify(item)}
                onChange={(e) => {
                  try {
                    updateItem(index, JSON.parse(e.target.value));
                  } catch {
                    // Ignore invalid JSON
                  }
                }}
                placeholder={`Item ${index + 1}`}
              />
            )}
          </div>
          <button
            type="button"
            onClick={() => removeItem(index)}
            className="text-destructive hover:text-destructive/80 px-2 py-1"
          >
            ×
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={addItem}
        className="text-sm text-primary hover:text-primary/80 font-medium"
      >
        + Add Item
      </button>
    </div>
  );
}

function getNestedValue(obj, path) {
  if (!obj || !path) return undefined;
  const keys = path.split('.');
  let current = obj;
  for (const key of keys) {
    if (current === null || current === undefined) return undefined;
    current = current[key];
  }
  return current;
}

function getFieldError(errors, path) {
  if (!errors || errors.length === 0) return null;
  
  // Try to find an error that matches this field path
  // This is a simplified matching - in production you'd want more robust path matching
  const fieldName = path.split('.').pop();
  const error = errors.find(e => 
    e.instancePath?.includes(fieldName) || 
    e.params?.missingProperty === fieldName ||
    e.params?.additionalProperty === fieldName
  );
  
  return error?.message || null;
}

export { SchemaForm };
