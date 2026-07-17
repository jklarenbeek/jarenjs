import { isStringType } from '@jarenjs/core';
import { getStringLength } from '@jarenjs/core/string';
import { compileJsonQuery } from '@jarenjs/json/query';
import { compileJtltStylesheet } from '@jarenjs/json/jtlt';
import {
  compileDataRef,
  compileJSONPath,
  compileJSONPointer,
  parseJSONPath,
  parseRelativeJSONPointer,
} from '@jarenjs/json';
import type {
  JSONPathAst,
  JSONPathNode,
  JSONPathQuery,
  JSONPathSegment,
  JSONPathSelector,
  JsonPointerGetter,
  RelativeJsonPointer,
  RelativeJsonPointerResolver,
} from '@jarenjs/json';
import { JarenValidator } from '@jarenjs/validate';
import type {
  DataKeywordSchema,
  DollarDataRef,
  FormatCompiler,
  JSONSchema,
} from '@jarenjs/validate';
import { createTypeTestCompiler } from '@jarenjs/validate/query';
import { stringFormats } from '@jarenjs/formats';
import type {
  FormatCompiler as StructuralFormatCompiler,
  FormatValidator,
} from '@jarenjs/formats';
import { getSchemaDraftByVersion } from '@jarenjs/refs';
import type { SchemaDraftInfo } from '@jarenjs/refs';
import { buildFormModel } from '@jarenjs/forms';

const validator = new JarenValidator();
validator.addFormats(stringFormats);
const validate = validator.compile({ type: 'string' });
const query = compileJsonQuery('$.name');
const render = compileJtltStylesheet([
  { match: '$.name', body: ['Hello ', '$'] },
]);
const form = buildFormModel({
  type: 'object',
  properties: {
    name: { type: 'string' },
  },
});

isStringType(query({ name: 'Jaren' }));
getStringLength(render({ name: 'Jaren' }));
validate('Jaren');
createTypeTestCompiler(validator);
getSchemaDraftByVersion(2020);
form.children;

// Named type exports of @jarenjs/validate
const minRef: DollarDataRef = { $data: '1/minNameLength' };
const dataKeyword: DataKeywordSchema = { minimum: '/limits/min', format: '/limits/format' };
const userSchema: JSONSchema = {
  $id: 'https://example.com/user',
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    name: { type: 'string', minLength: minRef, format: 'email' },
    age: { type: 'integer', minimum: 0 },
  },
  required: ['name'],
  data: dataKeyword,
  'x-custom-keyword': true,
};
const validateUser = validator.compile(userSchema);
validateUser({ name: 'jaren@example.com' });
const customFormat: FormatCompiler = (schemaObj, jsonSchema) =>
  (data) => typeof data === 'string' && data !== jsonSchema.format;
validator.addFormat('not-the-format-name', customFormat);

// Named type exports of @jarenjs/json
const pathQuery: JSONPathQuery = compileJSONPath('$.users[*].name');
const ast: JSONPathAst = parseJSONPath('$.users[*].name');
const segments: JSONPathSegment[] = ast.segments;
const selectors: JSONPathSelector[] = segments[0].selectors;
const nodes: JSONPathNode[] = pathQuery.nodes({ users: [{ name: 'Jaren' }] });
void pathQuery.ast.relative;
void nodes.map((node) => `${node.path}=${JSON.stringify(node.value)}`);
void selectors.length;
const getName: JsonPointerGetter = compileJSONPointer('/name');
getName({ name: 'Jaren' });
const relPtr: RelativeJsonPointer = parseRelativeJSONPointer('1/sibling');
void (relPtr.levels + relPtr.segments.length + (relPtr.hash ? 1 : 0));
const resolveRef: RelativeJsonPointerResolver = compileDataRef('0/name');
resolveRef({ name: 'Jaren' }, '');

// Named type exports of @jarenjs/formats
const emailCompiler: StructuralFormatCompiler = stringFormats['email'];
void emailCompiler;
const alwaysString: FormatValidator = (data) => typeof data === 'string';
alwaysString('Jaren', '/name');

// Named type exports of @jarenjs/refs
const draft: SchemaDraftInfo = getSchemaDraftByVersion(2020);
void `${draft.draft} (${draft.schema.length} schemas)`;
