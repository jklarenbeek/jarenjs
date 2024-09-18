import {
  isStringType,
  isFn,
} from '@jaren/core';

const registeredSchemaFormatters = {};
export function registerFormatCompiler(registered, name, formatCompiler) {
  if (registered[name] == null) {
    if (isFn(formatCompiler)) {
      registered[name] = formatCompiler;
      return true;
    }
  }
  return false;
}

export function registerFormatCompilers(registered, formatCompilers) {
  const keys = Object.keys(formatCompilers);
  for (let i = 0; i < keys.length; ++i) {
    const key = keys[i];
    const item = formatCompilers[key];
    registerFormatCompiler(registered, key, item);
  }
  return registered;
}

export function getSchemaFormatCompiler(registered, name) {
  if (isStringType(name))
    return registered[name];
  else
    return undefined;
}

export function compileFormatBasic(schemaObj, jsonSchema) {
  if (!isStringType(jsonSchema.format))
    return undefined;
  const compiler = getSchemaFormatCompiler(
    schemaObj.formats,
    jsonSchema.format);

  if (compiler)
    return compiler(schemaObj, jsonSchema);
  else
    throw new Error(`Unknown format ${jsonSchema.format}`);
}
