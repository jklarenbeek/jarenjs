/**
 * Example schemas for the playground, showcasing everything from the
 * basics to the draft 2019-09 / 2020-12 features Jaren fully supports.
 */
export const exampleSchemas = {
  simple: {
    name: 'Simple Object',
    schema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, description: 'Your full name' },
        age: { type: 'integer', minimum: 0, maximum: 150 },
        email: { type: 'string', format: 'email' },
      },
      required: ['name', 'age'],
    },
    data: { name: 'Ada Lovelace', age: 36, email: 'ada@example.com' },
  },

  user: {
    name: 'User Profile',
    schema: {
      type: 'object',
      title: 'User Profile',
      properties: {
        username: {
          type: 'string',
          pattern: '^[a-zA-Z0-9_]+$',
          minLength: 3,
          maxLength: 20,
          description: 'Letters, digits and underscores',
        },
        email: { type: 'string', format: 'email' },
        website: { type: 'string', format: 'uri' },
        birthDate: { type: 'string', format: 'date' },
        role: { type: 'string', enum: ['user', 'admin', 'moderator'], default: 'user' },
        active: { type: 'boolean', default: true },
      },
      required: ['username', 'email'],
    },
    data: {
      username: 'ada_l',
      email: 'ada@example.com',
      website: 'https://example.com',
      birthDate: '1815-12-10',
      role: 'admin',
      active: true,
    },
  },

  product: {
    name: 'Product',
    schema: {
      type: 'object',
      title: 'Product',
      properties: {
        id: { type: 'string', format: 'uuid', description: 'Product identifier' },
        name: { type: 'string', minLength: 1, maxLength: 100 },
        price: { type: 'number', exclusiveMinimum: 0, multipleOf: 0.01 },
        tags: {
          type: 'array',
          items: { type: 'string', minLength: 2 },
          uniqueItems: true,
          maxItems: 5,
        },
        inStock: { type: 'boolean' },
      },
      required: ['id', 'name', 'price'],
    },
    data: {
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Rubber Duck',
      price: 9.99,
      tags: ['bath', 'toy'],
      inStock: true,
    },
  },

  nested: {
    name: 'Nested + $defs',
    schema: {
      type: 'object',
      title: 'Order',
      properties: {
        customer: { $ref: '#/$defs/person' },
        shipping: { $ref: '#/$defs/address' },
        items: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              sku: { type: 'string', pattern: '^[A-Z]{2}-\\d{4}$' },
              quantity: { type: 'integer', minimum: 1, default: 1 },
            },
            required: ['sku'],
          },
        },
      },
      required: ['customer', 'items'],
      $defs: {
        person: {
          type: 'object',
          properties: {
            name: { type: 'string', minLength: 1 },
            email: { type: 'string', format: 'email' },
          },
          required: ['name'],
        },
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
    },
    data: {
      customer: { name: 'Ada Lovelace', email: 'ada@example.com' },
      shipping: { street: 'Main St 1', city: 'London', zipCode: '12345' },
      items: [{ sku: 'AB-1234', quantity: 2 }],
    },
  },

  conditional: {
    name: 'if / then / else',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      title: 'Payment',
      properties: {
        method: { type: 'string', enum: ['card', 'iban'] },
        cardNumber: { type: 'string', pattern: '^\\d{16}$' },
        iban: { type: 'string', format: 'iban' },
      },
      required: ['method'],
      if: { properties: { method: { const: 'card' } }, required: ['method'] },
      then: { required: ['cardNumber'] },
      else: { required: ['iban'] },
    },
    data: { method: 'card', cardNumber: '4111111111111111' },
  },

  unevaluated: {
    name: 'unevaluatedProperties',
    schema: {
      $schema: 'https://json-schema.org/draft/2019-09/schema',
      type: 'object',
      title: 'Extended Address',
      allOf: [
        {
          properties: {
            street: { type: 'string' },
            city: { type: 'string' },
          },
          required: ['street', 'city'],
        },
      ],
      properties: {
        type: { enum: ['residential', 'business'] },
      },
      unevaluatedProperties: false,
    },
    data: { street: 'Main St 1', city: 'London', type: 'business' },
  },

  dynamicRef: {
    name: '$dynamicRef (2020-12)',
    schema: {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: 'https://example.com/strict-tree',
      $dynamicAnchor: 'node',
      type: 'object',
      properties: {
        data: { type: 'string' },
        children: {
          type: 'array',
          items: { $dynamicRef: '#node' },
        },
      },
      unevaluatedProperties: false,
    },
    data: {
      data: 'root',
      children: [{ data: 'leaf' }],
    },
  },
};
