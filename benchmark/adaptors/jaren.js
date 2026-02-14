
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
    .addFormats(formats.dateTimeFormats);

  // Add meta-schema using addMetaSchema which properly processes internal refs
  // This is necessary for drafts like 2019-09 and 2020-12 that have multiple meta-schemas
  // We spread into a new array because addMetaSchema uses shift() which mutates the array
  jaren.addMetaSchema([...meta.schema], meta.draft);

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
