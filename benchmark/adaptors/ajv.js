
import Ajv from "ajv";
import addFormats from "ajv-formats";

import {
  getSchemaDraftByName,
} from '@jarenjs/refs';

export const name = "Jaren";

export function loader(draft, metaSchemas) {
  const meta = getSchemaDraftByName(draft);

  const ajv = new Ajv()
  addFormats(ajv);
  ajv.addSchema(meta.schema, meta.draft);
  return ajv;
}

export function setup(instance, schema) {
  return instance.compile(schema);
}

export function run(validator, data, schema) {
  return validator(data);
}
