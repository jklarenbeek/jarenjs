
import Ajv from "ajv";
import addFormats from "ajv-formats";
import Ajv2019 from "ajv/dist/2019.js";
import Ajv2020 from "ajv/dist/2020.js";

export const name = "Ajv";

export function loader(draft, remoteSchemas) {
  let ajv;
  
  // Common AJV options
  const ajvOptions = {
    strict: false,
    strictSchema: false,
    validateSchema: false,
    keywords: ["$note"],
    logger: false 
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

export function setup(instance, schema) {
  return instance.compile(schema);
}

export function run(validator, data, schema) {
  return validator(data);
}
