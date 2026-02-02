
import { JarenValidator } from "@jarenjs/validate";

import * as formats from '@jarenjs/formats';

import {
  getSchemaDraftByName,
} from '@jarenjs/refs';

export const name = "Jaren";

export function loader(draft, remoteSchemas) {
  const meta = getSchemaDraftByName(draft);

  const jaren = new JarenValidator()
    .addFormats(formats.numberFormats)
    .addFormats(formats.stringFormats)
    .addFormats(formats.dateTimeFormats)
    .addSchema(meta.schema, meta.draft);

  for (const id in remoteSchemas) {
    let schemaId = id;
    if (!schemaId.endsWith('#')) {
      schemaId += '#';
    }
    jaren.addSchema(remoteSchemas[id], schemaId);
  }

  return jaren;
}

export function setup(instance, schema) {
  return instance.compile(schema);
}

export function run(validator, data, schema) {
  return validator(data);
}
