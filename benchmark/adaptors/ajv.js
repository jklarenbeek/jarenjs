
import Ajv from "ajv";
import addFormats from "ajv-formats";

export const name = "Ajv";

export function loader(draft, remoteSchemas) {
  const ajv = new Ajv({
    strict: false,
    keywords: ["$note"],
    logger: false 
  });
  addFormats(ajv);
  
  if (remoteSchemas) {
    for (const id in remoteSchemas) {
      ajv.addSchema(remoteSchemas[id], id);
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
