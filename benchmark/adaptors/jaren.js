
import { JarenValidator } from "@jarenjs/validate";

import * as formats from '@jarenjs/formats';

import {
  getSchemaDraftByName,
} from '@jarenjs/refs';

export const name = "Jaren";

export function loader(draft, remoteSchemas) {
  const jaren = new JarenValidator()
    .addFormats(formats.numberFormats)
    .addFormats(formats.stringFormats)
    .addFormats(formats.dateTimeFormats);

  // Add meta-schemas using addMetaSchema which properly processes internal refs
  // This is necessary for drafts like 2019-09 and 2020-12 that have multiple meta-schemas
  // We spread into a new array because addMetaSchema uses shift() which mutates the array
  // The active draft goes first; the others are registered too so that
  // cross-draft references (and remotes built on other drafts) resolve.
  const seen = new Set();
  for (const name of [draft, 'draft6', 'draft7', 'draft2019-09', 'draft2020-12']) {
    const meta = getSchemaDraftByName(name);
    if (seen.has(meta.draft)) continue;
    seen.add(meta.draft);
    jaren.addMetaSchema([...meta.schema], meta.draft);
  }

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
