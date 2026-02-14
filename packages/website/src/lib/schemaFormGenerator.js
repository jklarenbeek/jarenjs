/**
 * Generate form field definitions from a JSON Schema
 * @param {Object} schema - JSON Schema object
 * @param {string} path - Current path (for nested properties)
 * @returns {Array} - Array of form field definitions
 */
export function generateFormFields(schema, path = '') {
  if (!schema || typeof schema !== 'object') {
    return [];
  }

  const fields = [];

  // Handle object type
  if (schema.type === 'object' && schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      const fieldPath = path ? `${path}.${key}` : key;
      const isRequired = schema.required?.includes(key);
      
      fields.push({
        path: fieldPath,
        name: key,
        schema: propSchema,
        required: isRequired,
        type: getFieldType(propSchema),
        nested: propSchema.type === 'object' || 
                (propSchema.type === 'array' && propSchema.items?.type === 'object'),
        children: propSchema.type === 'object' 
          ? generateFormFields(propSchema, fieldPath)
          : null,
      });
    }
  }

  // Handle array type with items
  if (schema.type === 'array' && schema.items) {
    fields.push({
      path,
      name: 'items',
      schema: schema.items,
      type: 'array',
      arrayItemType: getFieldType(schema.items),
      nested: true,
    });
  }

  return fields;
}

/**
 * Get the form field type from a schema
 * @param {Object} schema - Property schema
 * @returns {string} - Field type
 */
export function getFieldType(schema) {
  if (!schema) return 'text';
  
  if (schema.enum) return 'enum';
  if (schema.const) return 'const';
  
  switch (schema.type) {
    case 'string':
      if (schema.format === 'email') return 'email';
      if (schema.format === 'date' || schema.format === 'date-time') return 'date';
      if (schema.format === 'uri' || schema.format === 'url') return 'url';
      if (schema.format === 'password') return 'password';
      if (schema.format === 'textarea' || schema.format === 'multiline') return 'textarea';
      return 'text';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'checkbox';
    case 'array':
      return 'array';
    case 'object':
      return 'object';
    default:
      return 'text';
  }
}

/**
 * Get default value for a field type
 * @param {string} type - Field type
 * @returns {*} - Default value
 */
export function getDefaultValue(type) {
  switch (type) {
    case 'number':
    case 'integer':
      return 0;
    case 'boolean':
    case 'checkbox':
      return false;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return '';
  }
}

/**
 * Create initial form data from schema
 * @param {Object} schema - JSON Schema
 * @returns {Object} - Initial form data
 */
export function createInitialData(schema) {
  if (!schema || typeof schema !== 'object') {
    return null;
  }

  if (schema.type === 'object' && schema.properties) {
    const data = {};
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (propSchema.default !== undefined) {
        data[key] = propSchema.default;
      } else if (propSchema.type === 'object') {
        data[key] = createInitialData(propSchema);
      } else if (propSchema.type === 'array') {
        data[key] = [];
      } else {
        data[key] = getDefaultValue(propSchema.type);
      }
    }
    return data;
  }

  if (schema.type === 'array') {
    return [];
  }

  return getDefaultValue(schema.type);
}

/**
 * Validate a value against schema constraints
 * @param {*} value - Value to validate
 * @param {Object} schema - Property schema
 * @returns {string|null} - Error message or null if valid
 */
export function validateField(value, schema) {
  if (!schema) return null;

  // Required check
  if (schema.type !== 'boolean' && value === '') {
    if (schema.required) {
      return 'This field is required';
    }
    return null;
  }

  // Type-specific validations
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') {
        return 'Must be a string';
      }
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        return `Must be at least ${schema.minLength} characters`;
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return `Must be at most ${schema.maxLength} characters`;
      }
      if (schema.pattern) {
        const regex = new RegExp(schema.pattern);
        if (!regex.test(value)) {
          return `Must match pattern: ${schema.pattern}`;
        }
      }
      break;

    case 'number':
    case 'integer':
      const num = Number(value);
      if (isNaN(num)) {
        return 'Must be a number';
      }
      if (schema.type === 'integer' && !Number.isInteger(num)) {
        return 'Must be an integer';
      }
      if (schema.minimum !== undefined && num < schema.minimum) {
        return `Must be at least ${schema.minimum}`;
      }
      if (schema.maximum !== undefined && num > schema.maximum) {
        return `Must be at most ${schema.maximum}`;
      }
      if (schema.exclusiveMinimum !== undefined && num <= schema.exclusiveMinimum) {
        return `Must be greater than ${schema.exclusiveMinimum}`;
      }
      if (schema.exclusiveMaximum !== undefined && num >= schema.exclusiveMaximum) {
        return `Must be less than ${schema.exclusiveMaximum}`;
      }
      if (schema.multipleOf !== undefined && num % schema.multipleOf !== 0) {
        return `Must be a multiple of ${schema.multipleOf}`;
      }
      break;

    case 'array':
      if (!Array.isArray(value)) {
        return 'Must be an array';
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        return `Must have at least ${schema.minItems} items`;
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return `Must have at most ${schema.maxItems} items`;
      }
      break;
  }

  // Enum validation
  if (schema.enum && !schema.enum.includes(value)) {
    return `Must be one of: ${schema.enum.join(', ')}`;
  }

  return null;
}
