import {
  isStringType,
  isFn,
} from '@jaren/core';

const registeredSchemaFormatters = {};
export function registerFormatCompiler(name, formatCompiler) {
  if (registeredSchemaFormatters[name] == null) {
    if (isFn(formatCompiler)) {
      registeredSchemaFormatters[name] = formatCompiler;
      return true;
    }
  }
  return false;
}

export function registerFormatCompilers(formatCompilers) {
  const keys = Object.keys(formatCompilers);
  for (let i = 0; i < keys.length; ++i) {
    const key = keys[i];
    const item = formatCompilers[key];
    registerFormatCompiler(key, item);
  }
}

export function getSchemaFormatCompiler(name) {
  if (isStringType(name))
    return registeredSchemaFormatters[name];
  else
    return undefined;
}

export function compileFormatBasic(schemaObj, jsonSchema) {
  if (!isStringType(jsonSchema.format)) return undefined;
  const compiler = getSchemaFormatCompiler(jsonSchema.format);
  if (compiler)
    return compiler(schemaObj, jsonSchema);
  else
    throw new Error(`Unknown format ${jsonSchema.format}`);
}
