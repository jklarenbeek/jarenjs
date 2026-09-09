
import { JarenValidator, ValidatorOptions } from "@jarenjs/validate";

import * as formats from '@jarenjs/formats';

import {
  getSchemaDraftByName,
} from '@jarenjs/refs';

export const name = "Jaren";

function buildValidator(draft, remoteSchemas, options = undefined) {
  // `unknownFormats: 'ignore'` is Jaren's default and also the
  // specification's rule — "implementations MUST NOT fail validation or
  // cease processing due to an unknown format attribute", which
  // `optional/format/unknown.json` tests with assertion forced ON. It is
  // passed EXPLICITLY here anyway: this harness must measure the spec
  // whatever the library default happens to be, and a future flip of that
  // default would otherwise silently cost three tests (one per draft).
  const jaren = new JarenValidator(
    new ValidatorOptions({ unknownFormats: 'ignore', ...(options ?? {}) }))
    .addFormats(formats.numberFormats)
    .addFormats(formats.stringFormats)
    .addFormats(formats.dateTimeFormats)
    .addFormats(formats.jsonFormats);

  // Add meta-schemas using addMetaSchema which properly processes internal refs
  // This is necessary for drafts like 2019-09 and 2020-12 that have multiple meta-schemas
  // The active draft goes first; the others are registered too so that
  // cross-draft references (and remotes built on other drafts) resolve.
  const seen = new Set();
  for (const name of [draft, 'draft6', 'draft7', 'draft2019-09', 'draft2020-12']) {
    const meta = getSchemaDraftByName(name);
    if (seen.has(meta.draft)) continue;
    seen.add(meta.draft);
    jaren.addMetaSchema(meta.schema, meta.draft);
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

export function run(validator, data) {
  return validator(data);
}
