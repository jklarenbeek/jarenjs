import { describe, it } from 'node:test';
import * as assert from '@jarenjs/tools/assert';


import {
  compileSchemaValidator,
  registerFormatCompilers,
  ValidatorOptions
} from '@jarenjs/validate';

import * as formats from '@jarenjs/formats';

const options = new ValidatorOptions(
  registerFormatCompilers({}, formats.stringFormats)
);

// https://json-schema.org/understanding-json-schema/reference/string.html

describe('Schema String Formats', function () {

  describe('#formatBasic()', function () {
    it('should throw an error when the format is unknown', function () {
      assert.throws(() => compileSchemaValidator({
        format: 'something-invalid'
      }, options));
    });

    it('should validate format: \'alpha\'', function () {
      const root = compileSchemaValidator({
        format: 'alpha'
      }, options);

      assert.isTrue(root.validate(undefined), 'ignore undefined');
      assert.isTrue(root.validate(null), 'ignore null');
      assert.isTrue(root.validate(true), 'ignore boolean type');
      assert.isTrue(root.validate(1), 'ignore number type');
      assert.isTrue(root.validate({}), 'ignore object type');
      assert.isTrue(root.validate([]), 'ignore array type');
      assert.isTrue(root.validate('bitSOCIAL'), 'a valid letters only string');
      assert.isFalse(root.validate('2962'), 'an invalid string with numbers');
      assert.isFalse(root.validate('bit2SOCIAL'), 'an invalid mixed string with one number');
      assert.isFalse(root.validate('bit-SOCIAL'), 'an invalid mixed string with one symbol');
    });
    it('should validate format: \'alphanumeric\'', function () {
      const root = compileSchemaValidator({
        format: 'alphanumeric'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('bitSOCIAL'), 'a valid letters only string');
      assert.isTrue(root.validate('2962'), 'a valid string of numbers');
      assert.isTrue(root.validate('bit2SOCIAL'), 'a valid mixed string with one number');
      assert.isFalse(root.validate('bit-SOCIAL'), 'an invalid mixed string with one symbol');
    });
    it('should validate format: \'identifier\'', function () {
      const root = compileSchemaValidator({ 
        format: 'identifier'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('bitSOCIAL'), 'a valid letters only string');
      assert.isTrue(root.validate('_2962'), 'a valid string with underscore');
      assert.isTrue(root.validate('bit2SOCIAL'), 'a valid mixed string with one number');
      assert.isFalse(root.validate('bit-SOCIAL'), 'an invalid mixed string with one minus symbol');
      assert.isFalse(root.validate('-bit-SOCIAL'), 'an valid mixed string with one minus symbol up front');
      assert.isFalse(root.validate('bit:SOCIAL'), 'an valid mixed string with one colon symbol');
      assert.isFalse(root.validate('bit.SOCIAL'), 'an valid mixed string with one dot symbol');
      assert.isFalse(root.validate('bit SOCIAL'), 'an invalid mixed string with one symbol');
    });
    it('should validate format: \'html-identifier\'', function () {
      const root = compileSchemaValidator({
        format: 'html-identifier'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('bitSOCIAL'), 'a valid letters only string');
      assert.isFalse(root.validate('_2962'), 'an invalid string starting with an underscore');
      assert.isTrue(root.validate('bit2SOCIAL'), 'a valid mixed string with one number');
      assert.isTrue(root.validate('bit-SOCIAL'), 'an valid mixed string with one minus symbol');
      assert.isFalse(root.validate('-bit-SOCIAL'), 'an valid mixed string with one minus symbol up front');
      assert.isTrue(root.validate('bit:SOCIAL'), 'an valid mixed string with one colon symbol');
      assert.isTrue(root.validate('bit.SOCIAL'), 'an valid mixed string with one dot symbol');
      assert.isFalse(root.validate('bit SOCIAL'), 'an invalid mixed string with one symbol');
    });
    it('should validate format: \'css-identifier\'', function () {
      const root = compileSchemaValidator({
        format: 'css-identifier'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('bitSOCIAL'), 'a valid letters only string');
      assert.isTrue(root.validate('_2962'), 'a valid string with underscore');
      assert.isTrue(root.validate('bit2SOCIAL'), 'a valid mixed string with one number');
      assert.isTrue(root.validate('bit-SOCIAL'), 'an valid mixed string with one minus symbol');
      assert.isTrue(root.validate('-bit-SOCIAL'), 'an valid mixed string with one minus symbol up front');
      assert.isFalse(root.validate('bit:SOCIAL'), 'an valid mixed string with one colon symbol');
      assert.isFalse(root.validate('bit.SOCIAL'), 'an valid mixed string with one dot symbol');
      assert.isFalse(root.validate('bit SOCIAL'), 'an invalid mixed string with one symbol');
    });
    it('should validate format: \'color\'', function () {
      const root = compileSchemaValidator({
        format: 'color'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('#bada55'), 'a valid 6 digit hex color');
      assert.isTrue(root.validate('#fee'), 'a valid 3 digit hex color');
      assert.isFalse(root.validate('#aabbccdd'), 'an invalid color string with more then 6 digits');
      assert.isFalse(root.validate('#abcd'), 'an invalid color string with not 3 or 6 digits');
      assert.isFalse(root.validate('abcdbc'), 'an invalid color string missing the start hash');

    });
    it('should validate format: \'hexadecimal\'', function () {
      const root = compileSchemaValidator({
        format: 'hexadecimal'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('0123456789ABCDEF'), 'a valid string of hexadecimal digits');
      assert.isFalse(root.validate('_'), 'an invalid string with underscore');
      assert.isFalse(root.validate('ABGDE'), 'a invalid G in string');
    });
    it('should validate format: \'numeric\'', function () {
      const root = compileSchemaValidator({
        format: 'numeric'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isFalse(root.validate('0123456789ABCDEF'), 'an invalid string of hexadecimal digits');
      assert.isFalse(root.validate('_12345678'), 'an invalid string with underscore');
      assert.isFalse(root.validate('123ABC'), 'a invalid ABC string');
      assert.isTrue(root.validate('1234567890'), 'a invalid ABC string');
    });
    it('should validate format: \'uppercase\'', function () {
      const root = compileSchemaValidator({
        format: 'uppercase'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('0123456789ABCDEF'), 'an valid string of uppercase hexadecimal digits');
      assert.isFalse(root.validate('0123456789abcdef'), 'an invalid string with with lowercase hexadecimal digits');
      assert.isTrue(root.validate('123-ABC/12'), 'a valid ABC string with symbols');
    });
    it('should validate format: \'lowercase\'', function () {
      const root = compileSchemaValidator({
        format: 'lowercase'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isFalse(root.validate('0123456789ABCDEF'), 'an invalid string of uppercase hexadecimal digits');
      assert.isTrue(root.validate('0123456789abcdef'), 'an invalid string with with lowercase hexadecimal digits');
      assert.isFalse(root.validate('123-ABC/12'), 'a valid ABC string with symbols');
    });
    it('should validate format: \'regex\'', function () {
      const root = compileSchemaValidator({
        format: 'regex'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('([abc])+\\s+$'), 'a valid regular expression');
      assert.isFalse(root.validate('^(abc]'), 'a regular expression with unclosed parens is invalid');
    });
  });

  describe('#formatUuid()', function () {
    it('should validate format: \'uuid\'', function () {
      const root = compileSchemaValidator({
        format: 'uuid'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('12034ABC-FAFA-4AAA-8ABA-FEDCBA987654'), 'a valid uuid');
      assert.isFalse(root.validate('G2034ABC-FAFA-4AAA-8ABA-FEDCBA987654'), 'an invalid uuid');
    });
    it('should validate format: \'guid\'', function () {
      const root = compileSchemaValidator({
        format: 'uuid'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('12034ABC-FAFA-4AAA-8ABA-FEDCBA987654'), 'a valid uuid');
      assert.isFalse(root.validate('G2034ABC-FAFA-4AAA-8ABA-FEDCBA987654'), 'an invalid uuid');
    });
  });

  describe('#formatRef()', function () {
    it('should validate format: \'ipv4\'', function () {
      const root = compileSchemaValidator({
        format: 'ipv4'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('192.168.0.1'), 'a valid IP address');
      assert.isFalse(root.validate('127.0.0.0.1'), 'an IP address with too many components');
      assert.isFalse(root.validate('256.256.256.256'), 'an IP address with out-of-range values');
      assert.isFalse(root.validate('192.168.-10.1'), 'an invalid IP address with negative number');
      assert.isFalse(root.validate('127.0'), 'an IP address without 4 components');
      assert.isFalse(root.validate('0x7f000001'), 'an IP address as an integer');
    });
    it('should validate format: \'ipv6\'', function () {
      const root = compileSchemaValidator({
        format: 'ipv6'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('::1'), 'a valid IPv6 address');
      assert.isFalse(root.validate('12345::'), 'an IPv6 address with out-of-range values');
      assert.isFalse(root.validate('1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1'), 'an IPv6 address with too many components');
      assert.isFalse(root.validate('::laptop'), 'an IPv6 address containing illegal characters');
    });
    it('should validate format: \'hostname\'', function () {
      const root = compileSchemaValidator({
        format: 'hostname'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('www.example.com'), 'a valid hostname');
      assert.isTrue(root.validate('xn--4gbwdl.xn--wgbh1c'), 'a valid punycoded IDN hostname');
      assert.isFalse(root.validate('-a-host-name-that-starts-with--'), 'a host name starting with an illegal character');
      assert.isFalse(root.validate('not_a_valid_host_name'), 'a host name containing illegal characters');
      assert.isFalse(root.validate('a-vvvvvvvvvvvvvvvveeeeeeeeeeeeeeeerrrrrrrrrrrrrrrryyyyyyyyyyyyyyyy-long-host-name-component'), 'a host name with a component too long');
    });
    it('should validate format: \'idn-hostname\'', function () {
      const root = compileSchemaValidator({
        format: 'idn-hostname'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('실례.테스트'), 'a valid hostname (example.test in Hangul)');
      assert.isTrue(root.validate('a실례.테스트'), 'a valid first asci mixed hostname (example.test in Hangul)');
      assert.isTrue(root.validate('실례.com'), 'a valid mixed hostname (example.test in Hangul)');
      if (this === false) {
        assert.isFalse(root.validate('〮실례.테스트'), 'illegal first char U+302E Hangul single dot tone mark');
        assert.isFalse(root.validate('실〮례.테스트'), 'contains illegal char U+302E Hangul single dot tone mark');
      }
      assert.isFalse(root.validate('실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실례례테스트례례례례례례례례례례례례례례례례례테스트례례례례례례례례례례례례례례례례례례례테스트례례례례례례례례례례례례테스트례례실례.테스트'), 'a host name with a component too long');
    });
    it('should validate format: \'url\'', function () {
      const root = compileSchemaValidator({
        format: 'url'
      }, options);

      assert.isTrue(root.validate('http://example.com/'));
    });
    it('should validate format: \'url--full\'', function () {
      const root = compileSchemaValidator({
        format: 'url--full'
      }, options);

      assert.isTrue(root.validate('http://example.com/'));
    });
    it('should validate format: \'uri\'', function () {
      const root = compileSchemaValidator({
        format: 'uri'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('http://foo.bar/?baz=qux#quux'), 'a valid URL with anchor tag');
      assert.isTrue(root.validate('http://foo.com/blah_(wikipedia)_blah#cite-1'), 'a valid URL with anchor tag and parantheses');
      assert.isTrue(root.validate('http://foo.bar/?q=Test%20URL-encoded%20stuff'), 'a valid URL with URL-encoded stuff');
      assert.isTrue(root.validate('http://xn--nw2a.xn--j6w193g/'), 'a valid puny-coded URL');
      assert.isTrue(root.validate('http://-.~_!$&\'()*+,;=:%40:80%2f::::::@example.com'), 'a valid URL with many special characters');
      assert.isTrue(root.validate('http://223.255.255.254'), 'a valid URL based on IPv4');
      assert.isTrue(root.validate('ftp://ftp.is.co.za/rfc/rfc1808.txt'), 'a valid URL with ftp scheme');
      assert.isTrue(root.validate('http://www.ietf.org/rfc/rfc2396.txt'), 'a valid URL for a simple text file');
      assert.isTrue(root.validate('ldap://[2001:db8::7]/c=GB?objectClass?one'), 'a valid URL');
      assert.isTrue(root.validate('mailto:John.Doe@example.com'), 'a valid mailto URI');
      assert.isTrue(root.validate('news:comp.infosystems.www.servers.unix'), 'a valid newsgroup URI');
      assert.isTrue(root.validate('tel:+1-816-555-1212'), 'a valid tel URI');
      assert.isTrue(root.validate('urn:oasis:names:specification:docbook:dtd:xml:4.1.2'), 'a valid URN');
      assert.isTrue(root.validate('tag:example.com,2024:schemas/person'), 'a tagged urn');
      assert.isFalse(root.validate('//foo.bar/?baz=qux#quux'), 'an invalid protocol-relative URI Reference');
      assert.isFalse(root.validate('/abc'), 'an invalid relative URI Reference');
      assert.isFalse(root.validate('\\\\WINDOWS\\fileshare'), 'an invalid URI');
      assert.isFalse(root.validate('abc'), 'an invalid URI though valid URI reference');
      assert.isFalse(root.validate('http:// shouldfail.com'), 'an invalid URI with spaces');
      assert.isFalse(root.validate(':// should fail'), 'an invalid URI with spaces and missing scheme');
    });
    it('should validate format: \'uri--full\'', function () {
      const root = compileSchemaValidator({
        format: 'uri--full'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('http://foo.bar/?baz=qux#quux'), 'a valid URL with anchor tag');
      assert.isTrue(root.validate('http://foo.com/blah_(wikipedia)_blah#cite-1'), 'a valid URL with anchor tag and parantheses');
      assert.isTrue(root.validate('http://foo.bar/?q=Test%20URL-encoded%20stuff'), 'a valid URL with URL-encoded stuff');
      assert.isTrue(root.validate('http://xn--nw2a.xn--j6w193g/'), 'a valid puny-coded URL');
      assert.isTrue(root.validate('http://-.~_!$&\'()*+,;=:%40:80%2f::::::@example.com'), 'a valid URL with many special characters');
      assert.isTrue(root.validate('http://223.255.255.254'), 'a valid URL based on IPv4');
      assert.isTrue(root.validate('ftp://ftp.is.co.za/rfc/rfc1808.txt'), 'a valid URL with ftp scheme');
      assert.isTrue(root.validate('http://www.ietf.org/rfc/rfc2396.txt'), 'a valid URL for a simple text file');
      assert.isTrue(root.validate('ldap://[2001:db8::7]/c=GB?objectClass?one'), 'a valid URL');
      assert.isTrue(root.validate('mailto:John.Doe@example.com'), 'a valid mailto URI');
      assert.isTrue(root.validate('news:comp.infosystems.www.servers.unix'), 'a valid newsgroup URI');
      assert.isTrue(root.validate('tel:+1-816-555-1212'), 'a valid tel URI');
      assert.isTrue(root.validate('urn:oasis:names:specification:docbook:dtd:xml:4.1.2'), 'a valid URN');
      assert.isTrue(root.validate('tag:example.com,2024:schemas/person'), 'a tagged urn');
      assert.isFalse(root.validate('//foo.bar/?baz=qux#quux'), 'an invalid protocol-relative URI Reference');
      assert.isFalse(root.validate('/abc'), 'an invalid relative URI Reference');
      assert.isFalse(root.validate('\\\\WINDOWS\\fileshare'), 'an invalid URI');
      assert.isFalse(root.validate('abc'), 'an invalid URI though valid URI reference');
      assert.isFalse(root.validate('http:// shouldfail.com'), 'an invalid URI with spaces');
      assert.isFalse(root.validate(':// should fail'), 'an invalid URI with spaces and missing scheme');
    });
    it('should validate format: \'uri-reference\'', function () {
      const root = compileSchemaValidator({
        format: 'uri-reference'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('http://foo.bar/?baz=qux#quux'), 'a valid URI');
      assert.isTrue(root.validate('//foo.bar/?baz=qux#quux'), 'a valid protocol-relative URI Reference');
      assert.isTrue(root.validate('/abc'), 'a valid relative URI Reference');
      assert.isFalse(root.validate('\\\\WINDOWS\\fileshare'), 'an invalid URI Reference');
      assert.isTrue(root.validate('abc'), 'a valid URI Reference');
      assert.isTrue(root.validate('#fragment'), 'a valid URI fragment');
      assert.isFalse(root.validate('#frag\\ment'), 'an invalid URI fragment');
    });
    it('should validate format: \'uri-reference--full\'', function () {
      const root = compileSchemaValidator({
        format: 'uri-reference'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('http://foo.bar/?baz=qux#quux'), 'a valid URI');
      assert.isTrue(root.validate('//foo.bar/?baz=qux#quux'), 'a valid protocol-relative URI Reference');
      assert.isTrue(root.validate('/abc'), 'a valid relative URI Reference');
      assert.isFalse(root.validate('\\\\WINDOWS\\fileshare'), 'an invalid URI Reference');
      assert.isTrue(root.validate('abc'), 'a valid URI Reference');
      assert.isTrue(root.validate('#fragment'), 'a valid URI fragment');
      assert.isFalse(root.validate('#frag\\ment'), 'an invalid URI fragment');
    });
    it('should validate format: \'uri-template\'', function () {
      const root = compileSchemaValidator({
        format: 'uri-template'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('http://example.com/dictionary/{term:1}/{term}'), 'a valid uri-template');
      assert.isFalse(root.validate('http://example.com/dictionary/{term:1}/{term'), 'an invalid uri-template');
      assert.isTrue(root.validate('http://example.com/dictionary'), 'a valid uri-template without variables');
      assert.isTrue(root.validate('dictionary/{term:1}/{term}'), 'a valid relative uri-template');
    });
    it('should validate format: \'iri\'', function () {
      const root = compileSchemaValidator({
        format: 'iri'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('http://ƒøø.ßår/?∂éœ=πîx#πîüx'), 'a valid IRI with anchor tag');
      assert.isTrue(root.validate('http://ƒøø.com/blah_(wîkïpédiå)_blah#ßité-1'), 'a valid IRI with anchor tag and parantheses');
      assert.isTrue(root.validate('http://ƒøø.ßår/?q=Test%20URL-encoded%20stuff'), 'a valid IRI with URL-encoded stuff');
      assert.isTrue(root.validate('http://-.~_!$&\'()*+,;=:%40:80%2f::::::@example.com'), 'a valid IRI with many special characters');
      // TODO: assert.isTrue(root.validate('http://[2001:0db8:85a3:0000:0000:8a2e:0370:7334]'), 'a valid IRI based on IPv6');
      assert.isFalse(root.validate('http://2001:0db8:85a3:0000:0000:8a2e:0370:7334'), 'an invalid IRI based on IPv6');
      assert.isFalse(root.validate('/abc'), 'an invalid relative IRI Reference');
      assert.isFalse(root.validate('\\\\WINDOWS\\filëßåré'), 'an invalid IRI');
      assert.isFalse(root.validate('âππ'), 'an invalid IRI though valid IRI reference');
      assert.isFalse(root.validate('http:// ƒøø.com'), 'an invalid IRI by space in hostname');
    });
    it('should validate format: \'iri-reference\'', function () {
      const root = compileSchemaValidator({
        format: 'iri-reference'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('http://ƒøø.ßår/?∂éœ=πîx#πîüx'), 'a valid IRI');
      assert.isTrue(root.validate('//ƒøø.ßår/?∂éœ=πîx#πîüx'), 'a valid protocol-relative IRI Reference');
      assert.isTrue(root.validate('/âππ'), 'a valid relative IRI Reference');
      assert.isTrue(root.validate('âππ'), 'a valid IRI Reference');
      assert.isTrue(root.validate('#ƒrägmênt'), 'a valid IRI fragment');
      assert.isFalse(root.validate('\\\\WINDOWS\\filëßåré'), 'an invalid IRI Reference');
      assert.isFalse(root.validate('#ƒräg\\mênt'), 'an invalid IRI fragment');
    });
    it('should validate format: \'email\'', function () {
      const root = compileSchemaValidator({
        format: 'email'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('john.doe@example.com'), 'a valid email address');
      assert.isFalse(root.validate('2962'), 'an invalid email address');
    });
    it('should validate format: \'email--full\'', function () {
      const root = compileSchemaValidator({
        format: 'email--full'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('john.doe@example.com'), 'a valid email address');
      assert.isFalse(root.validate('2962'), 'an invalid email address');
    });
    it('should validate format: \'idn-email\'', function () {
      const root = compileSchemaValidator({
        format: 'idn-email'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('실례@실례.테스트'), 'a valid idn e-mail (example@example.test in Hangul)');
      assert.isFalse(root.validate('2962'), 'an invalid idn e-mail address');
    });

  });

  describe('#formatPointer()', function () {
    it('should validate format: \'json-pointer\'', function () {
      const root = compileSchemaValidator({
        format: 'json-pointer'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('/foo/bar~0/baz~1/%a'), 'a valid JSON-pointer');
      assert.isFalse(root.validate('/foo/bar~'), 'not a valid JSON-pointer (~ not escaped)');
      assert.isTrue(root.validate('/foo//bar'), 'valid JSON-pointer with empty segment');
      assert.isTrue(root.validate('/foo/bar/'), 'valid JSON-pointer with the last empty segment');
      assert.isTrue(root.validate(''), 'valid JSON-pointer as stated in RFC 6901 #1');
      assert.isTrue(root.validate('/foo'), 'valid JSON-pointer as stated in RFC 6901 #2');
      assert.isTrue(root.validate('/foo/0'), 'valid JSON-pointer as stated in RFC 6901 #3');
      assert.isTrue(root.validate('/'), 'valid JSON-pointer as stated in RFC 6901 #4');
      assert.isTrue(root.validate('/a~1b'), 'valid JSON-pointer as stated in RFC 6901 #5');
      assert.isTrue(root.validate('/c%d'), 'valid JSON-pointer as stated in RFC 6901 #6');
      assert.isTrue(root.validate('/e^f'), 'valid JSON-pointer as stated in RFC 6901 #7');
      assert.isTrue(root.validate('/g|h'), 'valid JSON-pointer as stated in RFC 6901 #8');
      assert.isTrue(root.validate('/i\\j'), 'valid JSON-pointer as stated in RFC 6901 #9');
      assert.isTrue(root.validate('/k\"l'), 'valid JSON-pointer as stated in RFC 6901 #10');
      assert.isTrue(root.validate('/ '), 'valid JSON-pointer as stated in RFC 6901 #11');
      assert.isTrue(root.validate('/m~0n'), 'valid JSON-pointer as stated in RFC 6901 #12');
      assert.isTrue(root.validate('/foo/-'), 'valid JSON-pointer used adding to the last array position');
      assert.isTrue(root.validate('/foo/-/bar'), 'valid JSON-pointer (- used as object member name)');
      assert.isTrue(root.validate('/~1~0~0~1~1'), 'valid JSON-pointer (multiple escaped characters)');
      assert.isTrue(root.validate('/~1.1'), 'valid JSON-pointer (escaped with fraction part) #1');
      assert.isTrue(root.validate('/~0.1'), 'valid JSON-pointer (escaped with fraction part) #2');
      assert.isFalse(root.validate('#'), 'not a valid JSON-pointer (URI Fragment Identifier) #1');
      assert.isFalse(root.validate('#/'), 'not a valid JSON-pointer (URI Fragment Identifier) #2');
      assert.isFalse(root.validate('#a'), 'not a valid JSON-pointer (URI Fragment Identifier) #3');
      assert.isFalse(root.validate('/~0~'), 'not a valid JSON-pointer (some escaped, but not all) #1');
      assert.isFalse(root.validate('/~0/~'), 'not a valid JSON-pointer (some escaped, but not all) #2');
      assert.isFalse(root.validate('/~2'), 'not a valid JSON-pointer (wrong escape character) #1');
      assert.isFalse(root.validate('/~-1'), 'not a valid JSON-pointer (wrong escape character) #2');
      assert.isFalse(root.validate('/~~'), 'not a valid JSON-pointer (multiple characters not escaped)');
      assert.isFalse(root.validate('a'), 'not a valid JSON-pointer (isn\'t empty nor starts with /) #1');
      assert.isFalse(root.validate('0'), 'not a valid JSON-pointer (isn\'t empty nor starts with /) #2');
      assert.isFalse(root.validate('a/a'), 'not a valid JSON-pointer (isn\'t empty nor starts with /) #3');
    });
    it('should validate format: \'relative-json-pointer\'', function () {
      const root = compileSchemaValidator({
        format: 'relative-json-pointer'
      }, options);

      assert.isTrue(root.validate(undefined), 'undefined is true');
      assert.isTrue(root.validate(null), 'null is true');
      assert.isTrue(root.validate('1'), 'a valid upwards RJP');
      assert.isTrue(root.validate('0/foo/bar'), 'a valid downwards RJP');
      assert.isTrue(root.validate('2/0/baz/1/zip'), 'a valid up and then down RJP, with array index');
      assert.isTrue(root.validate('0#'), 'a valid RJP taking the member or index name');
      assert.isFalse(root.validate('/foo/bar'), 'an invalid RJP that is a valid JSON Pointer');
    });
    it('should validate format: \'json-pointer-uri-fragment\'', function () {
      const root = compileSchemaValidator({
        format: 'json-pointer-uri-fragment'
      }, options);
      assert.isTrue(root.validate('#/$deps'));
      assert.isFalse(root.validate('#name'));
    });
  });

});
