import { useState, useCallback, useRef, useEffect } from 'react';
import { JarenValidator, ValidationOptions } from '@jarenjs/validate';
import { stringFormats } from '@jarenjs/formats';

/**
 * Custom hook for Jaren JSON Schema validation
 * @param {Object} options - Validation options
 * @returns {Object} - Validation state and functions
 */
export function useJarenValidator(options = {}) {
  const [errors, setErrors] = useState([]);
  const [isValid, setIsValid] = useState(null);
  const [compiledSchema, setCompiledSchema] = useState(null);
  const [compileError, setCompileError] = useState(null);
  const validatorRef = useRef(null);

  // Initialize validator instance
  useEffect(() => {
    const validationOpts = new ValidationOptions({
      skipErrors: options.skipErrors ?? false,
      useGrapheme: options.useGrapheme ?? true,
      collectErrors: true,
    });

    validatorRef.current = new JarenValidator({
      validation: validationOpts,
    }).addFormats(stringFormats);
  }, []);

  /**
   * Compile a JSON schema
   * @param {Object} schema - JSON schema to compile
   * @returns {boolean} - Whether compilation succeeded
   */
  const compileSchema = useCallback((schema) => {
    if (!validatorRef.current) return false;

    try {
      setCompileError(null);
      setErrors([]);
      setIsValid(null);
      
      const compiled = validatorRef.current.compile(schema);
      setCompiledSchema(compiled);
      return true;
    } catch (err) {
      setCompileError(err.message);
      setCompiledSchema(null);
      return false;
    }
  }, []);

  /**
   * Validate data against the compiled schema
   * @param {*} data - Data to validate
   * @returns {boolean|Object} - Validation result
   */
  const validate = useCallback((data) => {
    if (!compiledSchema) return null;

    try {
      const result = compiledSchema(data);
      
      // Handle both boolean and object return types
      if (typeof result === 'boolean') {
        setIsValid(result);
        if (!result && compiledSchema.errors) {
          setErrors(compiledSchema.errors);
        } else {
          setErrors([]);
        }
        return result;
      } else {
        // Object result with valid/errors
        setIsValid(result.valid);
        setErrors(result.errors || []);
        return result.valid;
      }
    } catch (err) {
      setIsValid(false);
      setErrors([{ message: err.message, keyword: 'exception' }]);
      return false;
    }
  }, [compiledSchema]);

  /**
   * Reset the validation state
   */
  const reset = useCallback(() => {
    setErrors([]);
    setIsValid(null);
    setCompiledSchema(null);
    setCompileError(null);
  }, []);

  return {
    compileSchema,
    validate,
    reset,
    errors,
    isValid,
    compileError,
    compiled: !!compiledSchema,
  };
}
