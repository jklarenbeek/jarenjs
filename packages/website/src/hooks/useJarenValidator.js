import { useState, useCallback, useMemo, useRef } from 'react';
import { JarenValidator } from '@jarenjs/validate';
import { stringFormats, numberFormats, dateTimeFormats, jsonFormats } from '@jarenjs/formats';

/**
 * Detect a friendly draft name from a schema's $schema declaration.
 * @param {Object} schema
 * @returns {string}
 */
export function detectDraftName(schema) {
  const url = (schema && typeof schema === 'object' && schema.$schema) || '';
  if (url.includes('2020-12')) return '2020-12';
  if (url.includes('2019-09')) return '2019-09';
  if (url.includes('draft-07')) return 'draft-07';
  if (url.includes('draft-06')) return 'draft-06';
  return 'draft-07 (default)';
}

/**
 * Custom hook for Jaren JSON Schema validation with error collection
 * and compile/validate timing.
 */
export function useJarenValidator(options = {}) {
  const [errors, setErrors] = useState([]);
  const [isValid, setIsValid] = useState(null);
  const [compileError, setCompileError] = useState(null);
  const [compiled, setCompiled] = useState(false);
  const [stats, setStats] = useState({ compileMs: null, validateMs: null });
  const compiledRef = useRef(null);
  const formatAssertion = options.formatAssertion ?? true;

  // A fresh validator instance per compile keeps schema registrations
  // (metaschemas, remote $ids) from colliding between edits.
  const createInstance = useCallback(() => {
    return new JarenValidator({
      skipErrors: false,
      collectErrors: true,
      formatAssertion,
    })
      .addFormats(stringFormats)
      .addFormats(numberFormats)
      .addFormats(dateTimeFormats)
      .addFormats(jsonFormats);
  }, [formatAssertion]);

  const compileSchema = useCallback((schema) => {
    try {
      const start = performance.now();
      const validateFn = createInstance().compile(schema);
      const compileMs = performance.now() - start;

      compiledRef.current = validateFn;
      setCompiled(true);
      setCompileError(null);
      setStats((s) => ({ ...s, compileMs }));
      return true;
    } catch (err) {
      compiledRef.current = null;
      setCompiled(false);
      setCompileError(err.message);
      setIsValid(null);
      setErrors([]);
      return false;
    }
  }, [createInstance]);

  const validate = useCallback((data) => {
    const validateFn = compiledRef.current;
    if (!validateFn) return null;

    try {
      const start = performance.now();
      const result = validateFn(data);
      const validateMs = performance.now() - start;
      setStats((s) => ({ ...s, validateMs }));

      if (typeof result === 'boolean') {
        setIsValid(result);
        setErrors([]);
        return result;
      }
      setIsValid(result.valid);
      setErrors(result.errors || []);
      return result.valid;
    } catch (err) {
      setIsValid(false);
      setErrors([{ message: err.message, keyword: 'exception', instancePath: '' }]);
      return false;
    }
  }, []);

  const reset = useCallback(() => {
    compiledRef.current = null;
    setCompiled(false);
    setErrors([]);
    setIsValid(null);
    setCompileError(null);
    setStats({ compileMs: null, validateMs: null });
  }, []);

  return useMemo(() => ({
    compileSchema,
    validate,
    reset,
    errors,
    isValid,
    compileError,
    compiled,
    stats,
  }), [compileSchema, validate, reset, errors, isValid, compileError, compiled, stats]);
}
