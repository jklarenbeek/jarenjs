//@ts-check
// eslint-disable no-useless-escape

import {
  isStringType,
} from '@jaren/core';

import {
  isStringLowerCase,
  isStringUpperCase,
  isStringRegExp,
} from '@jaren/core/string';

import {
  isStringUri,
  isStringUriRef,
  isStringUriTemplate,
  isStringJSONPointer,
  isStringJSONPointerUriFragment,
  isStringRelativeJSONPointer,
  isStringUrl,
  isStringEmail,
  isStringHostname,
  isStringIdnEmail,
  isStringIdnHostname,
  isStringIPv4,
  isStringIPv6,
  isStringUUID,
  isStringAlpha,
  isStringAlphaNumeric,
  isStringIdentifier,
  isStringHtmlIdentifier,
  isStringCssIdentifier,
  isStringHexaDecimal,
  isStringNumeric,
  isStringIRI,
  isStringIRIRef,
  isStringHexColor,
  isStringUriFull,
  isStringUriRefFull,
  isStringEmailFull,
  isStringGUID,
  isStringISBN10,
  isStringISBN13,
  isStringMACAddr,
  isStringBase64,
  isStringCountryAlpha2,
  isStringIBAN,
} from '@jaren/strings';

function createStringFormatCompiler(formatName, isFormatTest) {
  return function compileStringFormat(schemaObj, jsonSchema) {
    if (jsonSchema.format !== formatName)
      throw new Error('Format is not equal to jsonSchema (should not happen!)');

    const addError = schemaObj.createErrorHandler(formatName, 'format', isFormatTest.constructor.name);

    return function validateStringFormat(data, dataPath) {
      return isStringType(data)
        ? isFormatTest(data) || addError(data, dataPath)
        : true;
    };
  };
}

export const formatValidators = {
  'alpha': createStringFormatCompiler('alpha', isStringAlpha),
  'alphanumeric': createStringFormatCompiler('alphanumeric', isStringAlphaNumeric),
  'identifier': createStringFormatCompiler('identifier', isStringIdentifier),
  'html-identifier': createStringFormatCompiler('html-identifier', isStringHtmlIdentifier),
  'css-identifier': createStringFormatCompiler('css-identifier', isStringCssIdentifier),
  'hexadecimal': createStringFormatCompiler('hexadecimal', isStringHexaDecimal),
  'numeric': createStringFormatCompiler('numeric', isStringNumeric),
  'uppercase': createStringFormatCompiler('uppercase', isStringUpperCase),
  'lowercase': createStringFormatCompiler('lowercase', isStringLowerCase),
  'color': createStringFormatCompiler('color', isStringHexColor),
  'regex': createStringFormatCompiler('regex', isStringRegExp),
  'uri': createStringFormatCompiler('uri', isStringUri),
  'uri--full': createStringFormatCompiler('uri--full', isStringUriFull),
  'uri-reference': createStringFormatCompiler('uri-reference', isStringUriRef),
  'uri-reference--full': createStringFormatCompiler('uri-reference--full', isStringUriRefFull),
  'uri-template': createStringFormatCompiler('uri-template', isStringUriTemplate),
  'url': createStringFormatCompiler('url', isStringUrl),
  'url--full': createStringFormatCompiler('url--full', isStringUrl),
  'email': createStringFormatCompiler('email', isStringEmail),
  'email--full': createStringFormatCompiler('email--full', isStringEmailFull),
  'hostname': createStringFormatCompiler('hostname', isStringHostname),
  'idn-email': createStringFormatCompiler('idn-email', isStringIdnEmail),
  'idn-hostname': createStringFormatCompiler('idn-hostname', isStringIdnHostname),
  'ipv4': createStringFormatCompiler('ipv4', isStringIPv4),
  'ipv6': createStringFormatCompiler('ipv6', isStringIPv6),
  'uuid': createStringFormatCompiler('uuid', isStringUUID),
  'guid': createStringFormatCompiler('guid', isStringGUID),
  'json-pointer': createStringFormatCompiler('json-pointer', isStringJSONPointer),
  'json-pointer-uri-fragment': createStringFormatCompiler('json-pointer-uri-fragment', isStringJSONPointerUriFragment),
  'relative-json-pointer': createStringFormatCompiler('relative-json-pointer', isStringRelativeJSONPointer),
  'iri': createStringFormatCompiler('iri', isStringIRI),
  'iri-reference': createStringFormatCompiler('iri-reference', isStringIRIRef),
  'isbn10': createStringFormatCompiler('isbn10', isStringISBN10),
  'isbn13': createStringFormatCompiler('isbn13', isStringISBN13),
  'mac': createStringFormatCompiler('mac', isStringMACAddr),
  'base64': createStringFormatCompiler('base64', isStringBase64),
  'byte': createStringFormatCompiler('byte', isStringBase64),
  'country2': createStringFormatCompiler('country2', isStringCountryAlpha2),
  'iban': createStringFormatCompiler('iban', isStringIBAN),
};
