import { useState, useCallback, useEffect } from 'react';
import { SchemaEditor } from './SchemaEditor';
import { DataInput } from './DataInput';
import { ValidationResult } from './ValidationResult';
import { useJarenValidator } from '@hooks/useJarenValidator';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@components/ui/tabs';
import { SchemaForm } from './SchemaForm';

const defaultSchema = {
  type: 'object',
  properties: {
    name: { 
      type: 'string', 
      minLength: 1,
      description: 'Your full name'
    },
    email: { 
      type: 'string', 
      format: 'email',
      description: 'Your email address'
    },
    age: { 
      type: 'integer', 
      minimum: 0, 
      maximum: 150,
      description: 'Your age in years'
    },
    active: { 
      type: 'boolean',
      description: 'Account status'
    },
  },
  required: ['name', 'email'],
};

const defaultData = {
  name: 'John Doe',
  email: 'john@example.com',
  age: 30,
  active: true,
};

function LiveValidator() {
  const [schema, setSchema] = useState(defaultSchema);
  const [data, setData] = useState(defaultData);
  const [activeTab, setActiveTab] = useState('json');
  
  const {
    compileSchema,
    validate,
    errors,
    isValid,
    compileError,
    compiled,
  } = useJarenValidator({ skipErrors: false });

  // Compile schema when it changes
  useEffect(() => {
    compileSchema(schema);
  }, [schema, compileSchema]);

  // Validate data when it changes (if schema is compiled)
  useEffect(() => {
    if (compiled) {
      validate(data);
    }
  }, [data, compiled, validate]);

  const handleSchemaChange = useCallback((newSchema) => {
    setSchema(newSchema);
  }, []);

  const handleDataChange = useCallback((newData) => {
    setData(newData);
  }, []);

  const handleFormChange = useCallback((path, value) => {
    setData(prev => {
      const keys = path.split('.');
      const newData = { ...prev };
      let current = newData;
      
      for (let i = 0; i < keys.length - 1; i++) {
        current[keys[i]] = { ...current[keys[i]] };
        current = current[keys[i]];
      }
      
      current[keys[keys.length - 1]] = value;
      return newData;
    });
  }, []);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Left Column - Schema */}
      <div className="space-y-6">
        <SchemaEditor
          value={schema}
          onChange={handleSchemaChange}
          onCompile={compileSchema}
          isValid={compiled}
          error={compileError}
        />
      </div>

      {/* Right Column - Data & Results */}
      <div className="space-y-6">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="w-full">
            <TabsTrigger value="json">JSON Input</TabsTrigger>
            <TabsTrigger value="form">Generated Form</TabsTrigger>
          </TabsList>
          
          <TabsContent value="json" className="mt-4">
            <DataInput
              value={data}
              onChange={handleDataChange}
              onValidate={validate}
              isValid={isValid}
              schema={schema}
            />
          </TabsContent>
          
          <TabsContent value="form" className="mt-4">
            <SchemaForm
              schema={schema}
              value={data}
              onChange={handleFormChange}
              errors={errors}
            />
          </TabsContent>
        </Tabs>

        <ValidationResult
          isValid={isValid}
          errors={errors}
        />
      </div>
    </div>
  );
}

export { LiveValidator };
