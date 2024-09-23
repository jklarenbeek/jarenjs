//@ts-check
// eslint-disable no-useless-escape

import {
  isStringType,
} from '@jarenjs/core';

import {
  isStringLowerCase,
  isStringUpperCase,
  isStringRegExp,
} from '@jarenjs/core/string';

import {
  isValidUri,
  isValidUriRef,
  isValidUriTemplate,
  isValidJSONPointer,
  isValidJSONPointerUriFragment,
  isValidRelativeJSONPointer,
  isValidUrl,
  isValidEmail,
  isValidHostname,
  isValidIdnEmail,
  isValidIdnHostname,
  isValidIPv4,
  isValidIPv6,
  isValidUUID,
  isValidAlpha,
  isValidAlphaNumeric,
  isValidIdentifier,
  isValidHtmlIdentifier,
  isValidCssIdentifier,
  isValidHexaDecimal,
  isValidNumeric,
  isValidIRI,
  isValidIRIRef,
  isValidHexColor,
  isValidUriFull,
  isValidUriRefFull,
  isValidEmailFull,
  isValidGUID,
  isValidISBN10,
  isValidISBN13,
  isValidMACAddr,
  isValidBase64,
  isValidCountryAlpha2,
  isValidIBAN,
} from '@jarenjs/text';

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
  'alpha': createStringFormatCompiler('alpha', isValidAlpha),
  'alphanumeric': createStringFormatCompiler('alphanumeric', isValidAlphaNumeric),
  'identifier': createStringFormatCompiler('identifier', isValidIdentifier),
  'html-identifier': createStringFormatCompiler('html-identifier', isValidHtmlIdentifier),
  'css-identifier': createStringFormatCompiler('css-identifier', isValidCssIdentifier),
  'hexadecimal': createStringFormatCompiler('hexadecimal', isValidHexaDecimal),
  'numeric': createStringFormatCompiler('numeric', isValidNumeric),
  'uppercase': createStringFormatCompiler('uppercase', isStringUpperCase),
  'lowercase': createStringFormatCompiler('lowercase', isStringLowerCase),
  'color': createStringFormatCompiler('color', isValidHexColor),
  'regex': createStringFormatCompiler('regex', isStringRegExp),
  'uri': createStringFormatCompiler('uri', isValidUri),
  'uri--full': createStringFormatCompiler('uri--full', isValidUriFull),
  'uri-reference': createStringFormatCompiler('uri-reference', isValidUriRef),
  'uri-reference--full': createStringFormatCompiler('uri-reference--full', isValidUriRefFull),
  'uri-template': createStringFormatCompiler('uri-template', isValidUriTemplate),
  'url': createStringFormatCompiler('url', isValidUrl),
  'url--full': createStringFormatCompiler('url--full', isValidUrl),
  'email': createStringFormatCompiler('email', isValidEmail),
  'email--full': createStringFormatCompiler('email--full', isValidEmailFull),
  'hostname': createStringFormatCompiler('hostname', isValidHostname),
  'idn-email': createStringFormatCompiler('idn-email', isValidIdnEmail),
  'idn-hostname': createStringFormatCompiler('idn-hostname', isValidIdnHostname),
  'ipv4': createStringFormatCompiler('ipv4', isValidIPv4),
  'ipv6': createStringFormatCompiler('ipv6', isValidIPv6),
  'uuid': createStringFormatCompiler('uuid', isValidUUID),
  'guid': createStringFormatCompiler('guid', isValidGUID),
  'json-pointer': createStringFormatCompiler('json-pointer', isValidJSONPointer),
  'json-pointer-uri-fragment': createStringFormatCompiler('json-pointer-uri-fragment', isValidJSONPointerUriFragment),
  'relative-json-pointer': createStringFormatCompiler('relative-json-pointer', isValidRelativeJSONPointer),
  'iri': createStringFormatCompiler('iri', isValidIRI),
  'iri-reference': createStringFormatCompiler('iri-reference', isValidIRIRef),
  'isbn10': createStringFormatCompiler('isbn10', isValidISBN10),
  'isbn13': createStringFormatCompiler('isbn13', isValidISBN13),
  'mac': createStringFormatCompiler('mac', isValidMACAddr),
  'base64': createStringFormatCompiler('base64', isValidBase64),
  'byte': createStringFormatCompiler('byte', isValidBase64),
  'country2': createStringFormatCompiler('country2', isValidCountryAlpha2),
  'iban': createStringFormatCompiler('iban', isValidIBAN),
};
