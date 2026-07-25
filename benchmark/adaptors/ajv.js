
import Ajv from "ajv";
import addFormats from "ajv-formats";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";

export const name = "Ajv";

function buildInstance(draft, remoteSchemas, extraOptions = undefined) {
  let ajv;

  // Common AJV options
  const ajvOptions = {
    strict: false,
    strictSchema: false,
    validateSchema: false,
    keywords: ["$note"],
    logger: false,
    ...extraOptions,
  };

  // Create AJV instance based on draft version
  switch (draft) {
    case 'draft2019-09':
    case '2019':
      ajv = new Ajv2019(ajvOptions);
      break;
    case 'draft2020-12':
    case '2020':
      ajv = new Ajv2020(ajvOptions);
      break;
    case 'draft7':
    case 'draft-7':
    case '7':
    default:
      // Default AJV supports draft-07
      ajv = new Ajv(ajvOptions);
      break;
  }

  addFormats(ajv);

  if (remoteSchemas) {
    for (const id in remoteSchemas) {
      try {
        ajv.addSchema(remoteSchemas[id], id);
      } catch (e) {
        // Skip schemas that fail to load (e.g., incompatible $id formats)
        console.warn(`Warning: Failed to add remote schema '${id}': ${e.message}`);
      }
    }
  }
  return ajv;
}

const is2020 = (draft) => draft === 'draft2020-12' || draft === '2020';

export function loader(draft, remoteSchemas) {
  return {
    draft,
    remoteSchemas,
    // In 2020-12, format is annotation-only by default
    main: buildInstance(draft, remoteSchemas, is2020(draft) ? { validateFormats: false } : undefined),
    formatAssert: null,
  };
}

export function setup(instance, schema, suiteName = undefined) {
  // The optional/format suites assume the format-assertion behavior is
  // enabled (per the JSON-Schema-Test-Suite conventions).
  if (suiteName != null && suiteName.includes('/optional/format')) {
    if (instance.formatAssert == null) {
      instance.formatAssert = buildInstance(instance.draft, instance.remoteSchemas, { validateFormats: true });
    }
    return instance.formatAssert.compile(schema);
  }
  return instance.main.compile(schema);
}

export function run(validator, data) {
  return validator(data);
}
