import { Container } from '@components/layout/Container';
import { CodeBlock } from '@components/ui/code-block';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@components/ui/tabs';
import { Card, CardHeader, CardTitle, CardDescription } from '@components/ui/card';

const examples = {
  basic: {
    title: 'Basic Type Validation',
    description: 'Simple type checking with string, number, and boolean',
    schema: `{
  "type": "object",
  "properties": {
    "name": { 
      "type": "string",
      "minLength": 1 
    },
    "age": { 
      "type": "integer",
      "minimum": 0,
      "maximum": 150
    },
    "active": { 
      "type": "boolean" 
    }
  },
  "required": ["name", "age"]
}`,
    data: `{
  "name": "John Doe",
  "age": 30,
  "active": true
}`,
  },
  formats: {
    title: 'Format Validation',
    description: 'Validate common formats like email, dates, and URIs',
    schema: `{
  "type": "object",
  "properties": {
    "email": { 
      "type": "string",
      "format": "email"
    },
    "website": { 
      "type": "string",
      "format": "uri"
    },
    "birthDate": { 
      "type": "string",
      "format": "date"
    },
    "phone": {
      "type": "string",
      "pattern": "^\\+?[1-9]\\d{1,14}$"
    }
  },
  "required": ["email"]
}`,
    data: `{
  "email": "user@example.com",
  "website": "https://example.com",
  "birthDate": "1990-05-15",
  "phone": "+1234567890"
}`,
  },
  nested: {
    title: 'Nested Objects',
    description: 'Validate complex nested object structures',
    schema: `{
  "type": "object",
  "properties": {
    "user": {
      "type": "object",
      "properties": {
        "name": { "type": "string" },
        "address": {
          "type": "object",
          "properties": {
            "street": { "type": "string" },
            "city": { "type": "string" },
            "zipCode": { 
              "type": "string",
              "pattern": "^\\d{5}$"
            }
          },
          "required": ["street", "city"]
        }
      },
      "required": ["name"]
    }
  },
  "required": ["user"]
}`,
    data: `{
  "user": {
    "name": "Jane Smith",
    "address": {
      "street": "123 Main St",
      "city": "New York",
      "zipCode": "10001"
    }
  }
}`,
  },
  arrays: {
    title: 'Array Validation',
    description: 'Validate arrays with items, contains, and unique constraints',
    schema: `{
  "type": "object",
  "properties": {
    "tags": {
      "type": "array",
      "items": { "type": "string" },
      "minItems": 1,
      "uniqueItems": true
    },
    "scores": {
      "type": "array",
      "items": { 
        "type": "number",
        "minimum": 0,
        "maximum": 100
      }
    },
    "hasPremium": {
      "type": "array",
      "contains": { "const": "premium" }
    }
  }
}`,
    data: `{
  "tags": ["javascript", "json-schema", "validation"],
  "scores": [85, 92, 78, 95],
  "hasPremium": ["basic", "premium", "pro"]
}`,
  },
  conditional: {
    title: 'Conditional Validation',
    description: 'Use if/then/else for conditional schemas',
    schema: `{
  "type": "object",
  "properties": {
    "type": { 
      "type": "string",
      "enum": ["personal", "business"]
    },
    "name": { "type": "string" },
    "company": { "type": "string" },
    "taxId": { "type": "string" }
  },
  "required": ["type", "name"],
  "if": {
    "properties": {
      "type": { "const": "business" }
    }
  },
  "then": {
    "required": ["company", "taxId"]
  }
}`,
    data: `{
  "type": "business",
  "name": "John Doe",
  "company": "Acme Corp",
  "taxId": "123456789"
}`,
  },
  combiners: {
    title: 'Schema Combiners',
    description: 'allOf, anyOf, oneOf, and not',
    schema: `{
  "type": "object",
  "properties": {
    "contact": {
      "oneOf": [
        {
          "type": "object",
          "properties": {
            "email": { 
              "type": "string", 
              "format": "email" 
            }
          },
          "required": ["email"]
        },
        {
          "type": "object",
          "properties": {
            "phone": { "type": "string" }
          },
          "required": ["phone"]
        }
      ]
    }
  }
}`,
    data: `{
  "contact": {
    "email": "user@example.com"
  }
}`,
  },
  ref: {
    title: '$ref References',
    description: 'Reference and reuse schema definitions',
    schema: `{
  "$defs": {
    "address": {
      "type": "object",
      "properties": {
        "street": { "type": "string" },
        "city": { "type": "string" }
      },
      "required": ["street", "city"]
    }
  },
  "type": "object",
  "properties": {
    "billingAddress": {
      "$ref": "#/$defs/address"
    },
    "shippingAddress": {
      "$ref": "#/$defs/address"
    }
  }
}`,
    data: `{
  "billingAddress": {
    "street": "123 Main St",
    "city": "New York"
  },
  "shippingAddress": {
    "street": "456 Oak Ave",
    "city": "Los Angeles"
  }
}`,
  },
  metadata: {
    title: 'Metadata Keywords',
    description: 'Using title, description, default, and examples',
    schema: `{
  "title": "User Profile",
  "description": "A user profile schema",
  "type": "object",
  "properties": {
    "username": {
      "title": "Username",
      "description": "The user's unique identifier",
      "type": "string",
      "minLength": 3,
      "maxLength": 20,
      "examples": ["john_doe", "jane_smith"]
    },
    "role": {
      "type": "string",
      "enum": ["user", "admin"],
      "default": "user"
    },
    "createdAt": {
      "type": "string",
      "format": "date-time",
      "readOnly": true
    }
  }
}`,
    data: `{
  "username": "john_doe",
  "role": "user",
  "createdAt": "2024-01-15T10:30:00Z"
}`,
  },
};

function Examples() {
  return (
    <div className="py-8">
      <Container>
        <div className="mb-8">
          <h1 className="text-3xl font-bold mb-2">Examples</h1>
          <p className="text-muted-foreground">
            Explore common JSON Schema validation patterns and use cases.
          </p>
        </div>

        <div className="grid gap-6">
          {Object.entries(examples).map(([key, example]) => (
            <Card key={key} id={key}>
              <CardHeader>
                <CardTitle>{example.title}</CardTitle>
                <CardDescription>{example.description}</CardDescription>
              </CardHeader>
              <Tabs defaultValue="schema" className="px-6 pb-6">
                <TabsList>
                  <TabsTrigger value="schema">Schema</TabsTrigger>
                  <TabsTrigger value="data">Data</TabsTrigger>
                </TabsList>
                <TabsContent value="schema" className="mt-4">
                  <CodeBlock showCopy>{example.schema}</CodeBlock>
                </TabsContent>
                <TabsContent value="data" className="mt-4">
                  <CodeBlock showCopy>{example.data}</CodeBlock>
                </TabsContent>
              </Tabs>
            </Card>
          ))}
        </div>
      </Container>
    </div>
  );
}

export { Examples };
