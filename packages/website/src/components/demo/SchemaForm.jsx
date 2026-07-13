import { useMemo, useState, useCallback } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@components/ui/card';
import { Input } from '@components/ui/input';
import { Textarea } from '@components/ui/textarea';
import { Select } from '@components/ui/select';
import { Badge } from '@components/ui/badge';
import {
  buildFormModel,
  validateAllFields,
  createItemValue,
  parseFieldInput,
  getValueAtPointer,
} from '@jarenjs/forms';
import { AlertCircle, Plus, Trash2, CheckCircle2 } from 'lucide-react';
import { cn } from '@lib/utils';

/**
 * A form generated live from a JSON Schema (via @jarenjs/forms).
 *
 * Every field validates PREEMPTIVELY on each keystroke using @jarenjs/core
 * primitives (grapheme-aware lengths, unicode patterns, format testers),
 * while the full schema validation from @jarenjs/validate provides the
 * authoritative cross-field errors, matched to fields by instancePath.
 */
function SchemaForm({ schema, value, onChange, errors }) {
  const model = useMemo(() => {
    try {
      return buildFormModel(schema);
    } catch {
      return null;
    }
  }, [schema]);

  // Track which fields the user has interacted with, so pristine fields
  // don't show errors before they've been touched.
  const [touched, setTouched] = useState(() => new Set());

  const fieldErrors = useMemo(
    () => (model ? validateAllFields(model, value) : {}),
    [model, value],
  );

  // Full-schema errors (from @jarenjs/validate) indexed by instancePath,
  // for cross-field rules the per-field checks can't see.
  const schemaErrors = useMemo(() => {
    const map = {};
    for (const error of errors || []) {
      const pointer = error.instancePath || '';
      if (!map[pointer]) map[pointer] = [];
      map[pointer].push(error);
    }
    return map;
  }, [errors]);

  const handleChange = useCallback((pointer, newValue) => {
    setTouched((prev) => {
      if (prev.has(pointer)) return prev;
      const next = new Set(prev);
      next.add(pointer);
      return next;
    });
    onChange?.(pointer, newValue);
  }, [onChange]);

  if (!model || model.kind !== 'object' || !model.children?.length) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          <AlertCircle className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>Add an object schema with <code className="bg-muted px-1 rounded">properties</code> to generate a form</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-full">
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center justify-between">
          <span>{model.label || 'Generated Form'}</span>
          <span className="text-xs font-normal text-muted-foreground">
            powered by <code className="bg-muted px-1 rounded">@jarenjs/forms</code>
          </span>
        </CardTitle>
        {model.description && (
          <p className="text-sm text-muted-foreground">{model.description}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-5">
        {model.children.map((field) => (
          <FieldView
            key={field.key}
            field={field}
            pointer={`/${escapeKey(field.key)}`}
            data={value}
            onChange={handleChange}
            fieldErrors={fieldErrors}
            schemaErrors={schemaErrors}
            touched={touched}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function escapeKey(key) {
  return String(key).replace(/~/g, '~0').replace(/\//g, '~1');
}

function errorsFor(pointer, fieldErrors, schemaErrors, touched, hasValue) {
  const own = fieldErrors[pointer] || [];
  const showOwn = touched.has(pointer) || hasValue;
  const messages = showOwn ? own.map((e) => e.message) : [];

  // Cross-field errors from the full validation that the field checks
  // didn't already report
  if (showOwn) {
    const ownKeywords = new Set(own.map((e) => e.keyword));
    for (const error of schemaErrors[pointer] || []) {
      if (!ownKeywords.has(error.keyword) && error.message) {
        messages.push(error.message);
      }
    }
  }
  return messages;
}

function FieldView({ field, pointer, data, onChange, fieldErrors, schemaErrors, touched }) {
  const value = getValueAtPointer(data, pointer);
  const hasValue = value !== undefined && value !== '';
  const messages = errorsFor(pointer, fieldErrors, schemaErrors, touched, hasValue);
  const valid = messages.length === 0 && hasValue && field.kind !== 'object' && field.kind !== 'array';

  if (field.kind === 'object') {
    return (
      <fieldset className="rounded-lg border border-border p-4 space-y-4">
        <legend className="px-2 text-sm font-semibold flex items-center gap-2">
          {field.label}
          {field.required && <RequiredMark />}
        </legend>
        {field.description && (
          <p className="text-xs text-muted-foreground -mt-2">{field.description}</p>
        )}
        {field.children?.map((child) => (
          <FieldView
            key={child.key}
            field={child}
            pointer={`${pointer}/${escapeKey(child.key)}`}
            data={data}
            onChange={onChange}
            fieldErrors={fieldErrors}
            schemaErrors={schemaErrors}
            touched={touched}
          />
        ))}
        <FieldMessages messages={messages} />
      </fieldset>
    );
  }

  if (field.kind === 'array') {
    return (
      <ArrayFieldView
        field={field}
        pointer={pointer}
        data={data}
        onChange={onChange}
        fieldErrors={fieldErrors}
        schemaErrors={schemaErrors}
        touched={touched}
        messages={messages}
      />
    );
  }

  return (
    <div className="space-y-1.5">
      <FieldLabel field={field} valid={valid} />
      <FieldControl
        field={field}
        value={value}
        invalid={messages.length > 0}
        onChange={(raw) => onChange(pointer, parseFieldInput(field, raw))}
      />
      <FieldHints field={field} />
      <FieldMessages messages={messages} />
    </div>
  );
}

function FieldLabel({ field, valid }) {
  return (
    <label className="text-sm font-medium flex items-center gap-1.5">
      {field.label}
      {field.required && <RequiredMark />}
      {valid && <CheckCircle2 className="h-3.5 w-3.5 text-success" aria-label="valid" />}
    </label>
  );
}

function RequiredMark() {
  return <span className="text-destructive" title="Required">*</span>;
}

function FieldHints({ field }) {
  const c = field.constraints;
  const hints = [];
  if (field.description) hints.push(field.description);
  const bits = [];
  if (c.minLength !== undefined && c.maxLength !== undefined) {
    bits.push(`${c.minLength}–${c.maxLength} chars`);
  } else if (c.minLength !== undefined) {
    bits.push(`min ${c.minLength} char${c.minLength === 1 ? '' : 's'}`);
  } else if (c.maxLength !== undefined) {
    bits.push(`max ${c.maxLength} chars`);
  }
  if (c.minimum !== undefined && c.maximum !== undefined) {
    bits.push(`${c.minimum}…${c.maximum}`);
  } else if (c.minimum !== undefined) {
    bits.push(`≥ ${c.minimum}`);
  } else if (c.maximum !== undefined) {
    bits.push(`≤ ${c.maximum}`);
  }
  if (c.format) bits.push(c.format);
  if (c.pattern) bits.push(`pattern ${c.pattern}`);
  if (bits.length) hints.push(bits.join(' · '));
  if (hints.length === 0) return null;
  return <p className="text-xs text-muted-foreground">{hints.join(' — ')}</p>;
}

function FieldMessages({ messages }) {
  if (!messages?.length) return null;
  return (
    <div className="space-y-0.5">
      {messages.map((message, i) => (
        <p key={i} className="text-xs text-destructive flex items-center gap-1">
          <AlertCircle className="h-3 w-3 shrink-0" />
          {message}
        </p>
      ))}
    </div>
  );
}

function FieldControl({ field, value, invalid, onChange }) {
  const invalidCls = invalid && 'border-destructive focus-visible:ring-destructive';

  switch (field.control) {
    case 'checkbox':
      return (
        <label className="flex items-center gap-2 cursor-pointer py-1">
          <input
            type="checkbox"
            checked={!!value}
            onChange={(e) => onChange(e.target.checked)}
            className="h-4 w-4 rounded border-border accent-primary"
          />
          <span className="text-sm text-muted-foreground">
            {value ? 'Yes' : 'No'}
          </span>
        </label>
      );

    case 'select':
      return (
        <Select
          value={value === undefined ? '' : String(value)}
          onChange={(e) => onChange(e.target.value)}
          className={cn(invalidCls)}
        >
          <option value="">Select…</option>
          {field.enumValues?.map((option) => (
            <option key={String(option)} value={String(option)}>
              {typeof option === 'string' ? option : JSON.stringify(option)}
            </option>
          ))}
        </Select>
      );

    case 'const':
      return (
        <Input
          value={typeof field.constValue === 'string' ? field.constValue : JSON.stringify(field.constValue)}
          disabled
          className="bg-muted"
        />
      );

    case 'textarea':
      return (
        <Textarea
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          rows={3}
          className={cn(invalidCls)}
        />
      );

    case 'number':
      return (
        <Input
          type="number"
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          min={field.constraints.minimum}
          max={field.constraints.maximum}
          step={field.kind === 'integer' ? 1 : 'any'}
          placeholder={field.placeholder}
          className={cn(invalidCls)}
        />
      );

    case 'json':
      return (
        <Textarea
          value={value === undefined ? '' : JSON.stringify(value, null, 2)}
          onChange={(e) => {
            if (e.target.value.trim() === '') return onChange('');
            try {
              onChange(JSON.parse(e.target.value));
            } catch {
              onChange(e.target.value);
            }
          }}
          placeholder="JSON value"
          rows={3}
          className={cn('font-mono text-xs', invalidCls)}
        />
      );

    default: {
      // text / email / url / password / date / color / time
      const htmlType = ['email', 'url', 'password', 'date', 'color'].includes(field.control)
        ? field.control
        : 'text';
      return (
        <Input
          type={htmlType}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className={cn(invalidCls)}
        />
      );
    }
  }
}

function ArrayFieldView({ field, pointer, data, onChange, fieldErrors, schemaErrors, touched, messages }) {
  const value = getValueAtPointer(data, pointer);
  const items = Array.isArray(value) ? value : [];

  const addItem = () => {
    const itemField = field.tuple?.[items.length] ?? field.item;
    onChange(pointer, [...items, createItemValue(itemField)]);
  };

  const removeItem = (index) => {
    const next = items.slice();
    next.splice(index, 1);
    onChange(pointer, next);
  };

  const maxReached = field.constraints.maxItems !== undefined
    && items.length >= field.constraints.maxItems;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <FieldLabel field={field} valid={false} />
        <Badge variant="secondary" className="text-[10px]">
          {items.length} item{items.length === 1 ? '' : 's'}
        </Badge>
      </div>
      <FieldHints field={field} />

      <div className="space-y-2">
        {items.map((item, index) => {
          const itemField = field.tuple?.[index] ?? field.item;
          if (!itemField) return null;
          return (
            <div key={index} className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                {itemField.kind === 'object' || itemField.kind === 'array' ? (
                  <FieldView
                    field={{ ...itemField, label: `${field.label} #${index + 1}` }}
                    pointer={`${pointer}/${index}`}
                    data={data}
                    onChange={onChange}
                    fieldErrors={fieldErrors}
                    schemaErrors={schemaErrors}
                    touched={touched}
                  />
                ) : (
                  <ScalarArrayItem
                    itemField={itemField}
                    pointer={`${pointer}/${index}`}
                    data={data}
                    onChange={onChange}
                    fieldErrors={fieldErrors}
                    schemaErrors={schemaErrors}
                    touched={touched}
                  />
                )}
              </div>
              <button
                type="button"
                onClick={() => removeItem(index)}
                className="mt-1.5 p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                aria-label={`Remove item ${index + 1}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>

      <button
        type="button"
        onClick={addItem}
        disabled={maxReached}
        className={cn(
          'inline-flex items-center gap-1 text-sm font-medium rounded px-2 py-1 transition-colors',
          maxReached
            ? 'text-muted-foreground cursor-not-allowed'
            : 'text-primary hover:bg-primary/10',
        )}
      >
        <Plus className="h-4 w-4" />
        Add item
      </button>
      <FieldMessages messages={messages} />
    </div>
  );
}

function ScalarArrayItem({ itemField, pointer, data, onChange, fieldErrors, schemaErrors, touched }) {
  const value = getValueAtPointer(data, pointer);
  const hasValue = value !== undefined && value !== '';
  const messages = errorsFor(pointer, fieldErrors, schemaErrors, touched, hasValue);

  return (
    <div className="space-y-1">
      <FieldControl
        field={itemField}
        value={value}
        invalid={messages.length > 0}
        onChange={(raw) => onChange(pointer, parseFieldInput(itemField, raw))}
      />
      <FieldMessages messages={messages} />
    </div>
  );
}

export { SchemaForm };
