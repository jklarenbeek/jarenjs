
import { JarenValidator, ValidatorOptions } from "@jarenjs/validate";

import * as formats from '@jarenjs/formats';

import {
  getSchemaDraftByName,
} from '@jarenjs/refs';

export const name = "Jaren";

function buildValidator(draft, remoteSchemas, options = undefined) {
  const jaren = new JarenValidator(options ? new ValidatorOptions(options) : undefined)
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

export function loader(draft, remoteSchemas) {
  return {
    draft,
    remoteSchemas,
    main: buildValidator(draft, remoteSchemas),
    formatAssert: null,
  };
}

export function setup(instance, schema, suiteName = undefined) {
  // The optional/format suites assume the format-assertion behavior is
  // enabled (per the JSON-Schema-Test-Suite conventions).
  if (suiteName != null && suiteName.includes('/optional/format')) {
    if (instance.formatAssert == null) {
      instance.formatAssert = buildValidator(instance.draft, instance.remoteSchemas, { formatAssertion: true });
    }
    return instance.formatAssert.compile(schema);
  }
  return instance.main.compile(schema);
}

export function run(validator, data, schema) {
  return validator(data);
}
