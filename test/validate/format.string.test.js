import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';


import {
  JarenValidator,
} from '@jarenjs/validate';

import * as formats from '@jarenjs/formats';

const compiler = new JarenValidator();
compiler.addFormats(formats.stringFormats);

// https://json-schema.org/understanding-json-schema/reference/string.html

describe('Schema String Formats', function () {

  describe('#formatBasic()', function () {
    it('should throw an error when the format is unknown', function () {
      assert.throws(() => compiler.compile({
        format: 'something-invalid'
      }));
    });

    it('should validate format: \'alpha\'', function () {
      const validate = compiler.compile({
        format: 'alpha'
      });

      assert.isTrue(validate(undefined), 'ignore undefined');
      assert.isTrue(validate(null), 'ignore null');
      assert.isTrue(validate(true), 'ignore boolean type');
      assert.isTrue(validate(1), 'ignore number type');
      assert.isTrue(validate({}), 'ignore object type');
      assert.isTrue(validate([]), 'ignore array type');
      assert.isTrue(validate('bitSOCIAL'), 'a valid letters only string');
      assert.isFalse(validate('2962'), 'an invalid string with numbers');
      assert.isFalse(validate('bit2SOCIAL'), 'an invalid mixed string with one number');
      assert.isFalse(validate('bit-SOCIAL'), 'an invalid mixed string with one symbol');
    });
    it('should validate format: \'alphanumeric\'', function () {
      const validate = compiler.compile({
        format: 'alphanumeric'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('bitSOCIAL'), 'a valid letters only string');
      assert.isTrue(validate('2962'), 'a valid string of numbers');
      assert.isTrue(validate('bit2SOCIAL'), 'a valid mixed string with one number');
      assert.isFalse(validate('bit-SOCIAL'), 'an invalid mixed string with one symbol');
    });
    it('should validate format: \'identifier\'', function () {
      const validate = compiler.compile({ 
        format: 'identifier'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('bitSOCIAL'), 'a valid letters only string');
      assert.isTrue(validate('_2962'), 'a valid string with underscore');
      assert.isTrue(validate('bit2SOCIAL'), 'a valid mixed string with one number');
      assert.isFalse(validate('bit-SOCIAL'), 'an invalid mixed string with one minus symbol');
      assert.isFalse(validate('-bit-SOCIAL'), 'an valid mixed string with one minus symbol up front');
      assert.isFalse(validate('bit:SOCIAL'), 'an valid mixed string with one colon symbol');
      assert.isFalse(validate('bit.SOCIAL'), 'an valid mixed string with one dot symbol');
      assert.isFalse(validate('bit SOCIAL'), 'an invalid mixed string with one symbol');
    });
    it('should validate format: \'html-identifier\'', function () {
      const validate = compiler.compile({
        format: 'html-identifier'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('bitSOCIAL'), 'a valid letters only string');
      assert.isFalse(validate('_2962'), 'an invalid string starting with an underscore');
      assert.isTrue(validate('bit2SOCIAL'), 'a valid mixed string with one number');
      assert.isTrue(validate('bit-SOCIAL'), 'an valid mixed string with one minus symbol');
      assert.isFalse(validate('-bit-SOCIAL'), 'an valid mixed string with one minus symbol up front');
      assert.isTrue(validate('bit:SOCIAL'), 'an valid mixed string with one colon symbol');
      assert.isTrue(validate('bit.SOCIAL'), 'an valid mixed string with one dot symbol');
      assert.isFalse(validate('bit SOCIAL'), 'an invalid mixed string with one symbol');
    });
    it('should validate format: \'css-identifier\'', function () {
      const validate = compiler.compile({
        format: 'css-identifier'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('bitSOCIAL'), 'a valid letters only string');
      assert.isTrue(validate('_2962'), 'a valid string with underscore');
      assert.isTrue(validate('bit2SOCIAL'), 'a valid mixed string with one number');
      assert.isTrue(validate('bit-SOCIAL'), 'an valid mixed string with one minus symbol');
      assert.isTrue(validate('-bit-SOCIAL'), 'an valid mixed string with one minus symbol up front');
      assert.isFalse(validate('bit:SOCIAL'), 'an valid mixed string with one colon symbol');
      assert.isFalse(validate('bit.SOCIAL'), 'an valid mixed string with one dot symbol');
      assert.isFalse(validate('bit SOCIAL'), 'an invalid mixed string with one symbol');
    });
    it('should validate format: \'color\'', function () {
      const validate = compiler.compile({
        format: 'color'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('#bada55'), 'a valid 6 digit hex color');
      assert.isTrue(validate('#fee'), 'a valid 3 digit hex color');
      assert.isFalse(validate('#aabbccdd'), 'an invalid color string with more then 6 digits');
      assert.isFalse(validate('#abcd'), 'an invalid color string with not 3 or 6 digits');
      assert.isFalse(validate('abcdbc'), 'an invalid color string missing the start hash');

    });
    it('should validate format: \'hexadecimal\'', function () {
      const validate = compiler.compile({
        format: 'hexadecimal'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('0123456789ABCDEF'), 'a valid string of hexadecimal digits');
      assert.isFalse(validate('_'), 'an invalid string with underscore');
      assert.isFalse(validate('ABGDE'), 'a invalid G in string');
    });
    it('should validate format: \'numeric\'', function () {
      const validate = compiler.compile({
        format: 'numeric'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isFalse(validate('0123456789ABCDEF'), 'an invalid string of hexadecimal digits');
      assert.isFalse(validate('_12345678'), 'an invalid string with underscore');
      assert.isFalse(validate('123ABC'), 'a invalid ABC string');
      assert.isTrue(validate('1234567890'), 'a invalid ABC string');
    });
    it('should validate format: \'uppercase\'', function () {
      const validate = compiler.compile({
        format: 'uppercase'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('0123456789ABCDEF'), 'an valid string of uppercase hexadecimal digits');
      assert.isFalse(validate('0123456789abcdef'), 'an invalid string with with lowercase hexadecimal digits');
      assert.isTrue(validate('123-ABC/12'), 'a valid ABC string with symbols');
    });
    it('should validate format: \'lowercase\'', function () {
      const validate = compiler.compile({
        format: 'lowercase'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isFalse(validate('0123456789ABCDEF'), 'an invalid string of uppercase hexadecimal digits');
      assert.isTrue(validate('0123456789abcdef'), 'an invalid string with with lowercase hexadecimal digits');
      assert.isFalse(validate('123-ABC/12'), 'a valid ABC string with symbols');
    });
    it('should validate format: \'regex\'', function () {
      const validate = compiler.compile({
        format: 'regex'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('([abc])+\\s+$'), 'a valid regular expression');
      assert.isFalse(validate('^(abc]'), 'a regular expression with unclosed parens is invalid');
    });
  });

  describe('#formatUuid()', function () {
    it('should validate format: \'uuid\'', function () {
      const validate = compiler.compile({
        format: 'uuid'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('12034ABC-FAFA-4AAA-8ABA-FEDCBA987654'), 'a valid uuid');
      assert.isFalse(validate('G2034ABC-FAFA-4AAA-8ABA-FEDCBA987654'), 'an invalid uuid');
    });
    it('should validate format: \'guid\'', function () {
      const validate = compiler.compile({
        format: 'uuid'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('12034ABC-FAFA-4AAA-8ABA-FEDCBA987654'), 'a valid uuid');
      assert.isFalse(validate('G2034ABC-FAFA-4AAA-8ABA-FEDCBA987654'), 'an invalid uuid');
    });
  });

  describe('#formatRef()', function () {
    it('should validate format: \'ipv4\'', function () {
      const validate = compiler.compile({
        format: 'ipv4'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('192.168.0.1'), 'a valid IP address');
      assert.isFalse(validate('127.0.0.0.1'), 'an IP address with too many components');
      assert.isFalse(validate('256.256.256.256'), 'an IP address with out-of-range values');
      assert.isFalse(validate('192.168.-10.1'), 'an invalid IP address with negative number');
      assert.isFalse(validate('127.0'), 'an IP address without 4 components');
      assert.isFalse(validate('0x7f000001'), 'an IP address as an integer');
    });
    it('should validate format: \'ipv6\'', function () {
      const validate = compiler.compile({
        format: 'ipv6'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('::1'), 'a valid IPv6 address');
      assert.isFalse(validate('12345::'), 'an IPv6 address with out-of-range values');
      assert.isFalse(validate('1:1:1:1:1:1:1:1:1:1:1:1:1:1:1:1'), 'an IPv6 address with too many components');
      assert.isFalse(validate('::laptop'), 'an IPv6 address containing illegal characters');
    });
    it('should validate format: \'hostname\'', function () {
      const validate = compiler.compile({
        format: 'hostname'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('www.example.com'), 'a valid hostname');
      assert.isTrue(validate('xn--4gbwdl.xn--wgbh1c'), 'a valid punycoded IDN hostname');
      assert.isFalse(validate('-a-host-name-that-starts-with--'), 'a host name starting with an illegal character');
      assert.isFalse(validate('not_a_valid_host_name'), 'a host name containing illegal characters');
      assert.isFalse(validate('a-vvvvvvvvvvvvvvvveeeeeeeeeeeeeeeerrrrrrrrrrrrrrrryyyyyyyyyyyyyyyy-long-host-name-component'), 'a host name with a component too long');
    });
    it('should validate format: \'idn-hostname\'', function () {
      const validate = compiler.compile({
        format: 'idn-hostname'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('실례.테스트'), 'a valid hostname (example.test in Hangul)');
      assert.isTrue(validate('a실례.테스트'), 'a valid first asci mixed hostname (example.test in Hangul)');
      assert.isTrue(validate('실례.com'), 'a valid mixed hostname (example.test in Hangul)');
      if (this === false) {
        assert.isFalse(validate('〮실례.테스트'), 'illegal first char U+302E Hangul single dot tone mark');
        assert.isFalse(validate('실〮례.테스트'), 'contains illegal char U+302E Hangul single dot tone mark');
      }
      assert.isFalse(validate('실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실실례례테스트례례례례례례례례례례례례례례례례례테스트례례례례례례례례례례례례례례례례례례례테스트례례례례례례례례례례례례테스트례례실례.테스트'), 'a host name with a component too long');
    });
    it('should validate format: \'url\'', function () {
      const validate = compiler.compile({
        format: 'url'
      });

      assert.isTrue(validate('http://example.com/'));
    });
    it('should validate format: \'url--full\'', function () {
      const validate = compiler.compile({
        format: 'url--full'
      });

      assert.isTrue(validate('http://example.com/'));
    });
    it('should validate format: \'uri\'', function () {
      const validate = compiler.compile({
        format: 'uri'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('http://foo.bar/?baz=qux#quux'), 'a valid URL with anchor tag');
      assert.isTrue(validate('http://foo.com/blah_(wikipedia)_blah#cite-1'), 'a valid URL with anchor tag and parantheses');
      assert.isTrue(validate('http://foo.bar/?q=Test%20URL-encoded%20stuff'), 'a valid URL with URL-encoded stuff');
      assert.isTrue(validate('http://xn--nw2a.xn--j6w193g/'), 'a valid puny-coded URL');
      assert.isTrue(validate('http://-.~_!$&\'()*+,;=:%40:80%2f::::::@example.com'), 'a valid URL with many special characters');
      assert.isTrue(validate('http://223.255.255.254'), 'a valid URL based on IPv4');
      assert.isTrue(validate('ftp://ftp.is.co.za/rfc/rfc1808.txt'), 'a valid URL with ftp scheme');
      assert.isTrue(validate('http://www.ietf.org/rfc/rfc2396.txt'), 'a valid URL for a simple text file');
      assert.isTrue(validate('ldap://[2001:db8::7]/c=GB?objectClass?one'), 'a valid URL');
      assert.isTrue(validate('mailto:John.Doe@example.com'), 'a valid mailto URI');
      assert.isTrue(validate('news:comp.infosystems.www.servers.unix'), 'a valid newsgroup URI');
      assert.isTrue(validate('tel:+1-816-555-1212'), 'a valid tel URI');
      assert.isTrue(validate('urn:oasis:names:specification:docbook:dtd:xml:4.1.2'), 'a valid URN');
      assert.isTrue(validate('tag:example.com,2024:schemas/person'), 'a tagged urn');
      assert.isFalse(validate('//foo.bar/?baz=qux#quux'), 'an invalid protocol-relative URI Reference');
      assert.isFalse(validate('/abc'), 'an invalid relative URI Reference');
      assert.isFalse(validate('\\\\WINDOWS\\fileshare'), 'an invalid URI');
      assert.isFalse(validate('abc'), 'an invalid URI though valid URI reference');
      assert.isFalse(validate('http:// shouldfail.com'), 'an invalid URI with spaces');
      assert.isFalse(validate(':// should fail'), 'an invalid URI with spaces and missing scheme');
    });
    it('should validate format: \'uri--full\'', function () {
      const validate = compiler.compile({
        format: 'uri--full'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('http://foo.bar/?baz=qux#quux'), 'a valid URL with anchor tag');
      assert.isTrue(validate('http://foo.com/blah_(wikipedia)_blah#cite-1'), 'a valid URL with anchor tag and parantheses');
      assert.isTrue(validate('http://foo.bar/?q=Test%20URL-encoded%20stuff'), 'a valid URL with URL-encoded stuff');
      assert.isTrue(validate('http://xn--nw2a.xn--j6w193g/'), 'a valid puny-coded URL');
      assert.isTrue(validate('http://-.~_!$&\'()*+,;=:%40:80%2f::::::@example.com'), 'a valid URL with many special characters');
      assert.isTrue(validate('http://223.255.255.254'), 'a valid URL based on IPv4');
      assert.isTrue(validate('ftp://ftp.is.co.za/rfc/rfc1808.txt'), 'a valid URL with ftp scheme');
      assert.isTrue(validate('http://www.ietf.org/rfc/rfc2396.txt'), 'a valid URL for a simple text file');
      assert.isTrue(validate('ldap://[2001:db8::7]/c=GB?objectClass?one'), 'a valid URL');
      assert.isTrue(validate('mailto:John.Doe@example.com'), 'a valid mailto URI');
      assert.isTrue(validate('news:comp.infosystems.www.servers.unix'), 'a valid newsgroup URI');
      assert.isTrue(validate('tel:+1-816-555-1212'), 'a valid tel URI');
      assert.isTrue(validate('urn:oasis:names:specification:docbook:dtd:xml:4.1.2'), 'a valid URN');
      assert.isTrue(validate('tag:example.com,2024:schemas/person'), 'a tagged urn');
      assert.isFalse(validate('//foo.bar/?baz=qux#quux'), 'an invalid protocol-relative URI Reference');
      assert.isFalse(validate('/abc'), 'an invalid relative URI Reference');
      assert.isFalse(validate('\\\\WINDOWS\\fileshare'), 'an invalid URI');
      assert.isFalse(validate('abc'), 'an invalid URI though valid URI reference');
      assert.isFalse(validate('http:// shouldfail.com'), 'an invalid URI with spaces');
      assert.isFalse(validate(':// should fail'), 'an invalid URI with spaces and missing scheme');
    });
    it('should validate format: \'uri-reference\'', function () {
      const validate = compiler.compile({
        format: 'uri-reference'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('http://foo.bar/?baz=qux#quux'), 'a valid URI');
      assert.isTrue(validate('//foo.bar/?baz=qux#quux'), 'a valid protocol-relative URI Reference');
      assert.isTrue(validate('/abc'), 'a valid relative URI Reference');
      assert.isFalse(validate('\\\\WINDOWS\\fileshare'), 'an invalid URI Reference');
      assert.isTrue(validate('abc'), 'a valid URI Reference');
      assert.isTrue(validate('#fragment'), 'a valid URI fragment');
      assert.isFalse(validate('#frag\\ment'), 'an invalid URI fragment');
    });
    it('should validate format: \'uri-reference--full\'', function () {
      const validate = compiler.compile({
        format: 'uri-reference'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('http://foo.bar/?baz=qux#quux'), 'a valid URI');
      assert.isTrue(validate('//foo.bar/?baz=qux#quux'), 'a valid protocol-relative URI Reference');
      assert.isTrue(validate('/abc'), 'a valid relative URI Reference');
      assert.isFalse(validate('\\\\WINDOWS\\fileshare'), 'an invalid URI Reference');
      assert.isTrue(validate('abc'), 'a valid URI Reference');
      assert.isTrue(validate('#fragment'), 'a valid URI fragment');
      assert.isFalse(validate('#frag\\ment'), 'an invalid URI fragment');
    });
    it('should validate format: \'uri-template\'', function () {
      const validate = compiler.compile({
        format: 'uri-template'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('http://example.com/dictionary/{term:1}/{term}'), 'a valid uri-template');
      assert.isFalse(validate('http://example.com/dictionary/{term:1}/{term'), 'an invalid uri-template');
      assert.isTrue(validate('http://example.com/dictionary'), 'a valid uri-template without variables');
      assert.isTrue(validate('dictionary/{term:1}/{term}'), 'a valid relative uri-template');
    });
    it('should validate format: \'iri\'', function () {
      const validate = compiler.compile({
        format: 'iri'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('http://ƒøø.ßår/?∂éœ=πîx#πîüx'), 'a valid IRI with anchor tag');
      assert.isTrue(validate('http://ƒøø.com/blah_(wîkïpédiå)_blah#ßité-1'), 'a valid IRI with anchor tag and parantheses');
      assert.isTrue(validate('http://ƒøø.ßår/?q=Test%20URL-encoded%20stuff'), 'a valid IRI with URL-encoded stuff');
      assert.isTrue(validate('http://-.~_!$&\'()*+,;=:%40:80%2f::::::@example.com'), 'a valid IRI with many special characters');
      // TODO: assert.isTrue(validate('http://[2001:0db8:85a3:0000:0000:8a2e:0370:7334]'), 'a valid IRI based on IPv6');
      assert.isFalse(validate('http://2001:0db8:85a3:0000:0000:8a2e:0370:7334'), 'an invalid IRI based on IPv6');
      assert.isFalse(validate('/abc'), 'an invalid relative IRI Reference');
      assert.isFalse(validate('\\\\WINDOWS\\filëßåré'), 'an invalid IRI');
      assert.isFalse(validate('âππ'), 'an invalid IRI though valid IRI reference');
      assert.isFalse(validate('http:// ƒøø.com'), 'an invalid IRI by space in hostname');
    });
    it('should validate format: \'iri-reference\'', function () {
      const validate = compiler.compile({
        format: 'iri-reference'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('http://ƒøø.ßår/?∂éœ=πîx#πîüx'), 'a valid IRI');
      assert.isTrue(validate('//ƒøø.ßår/?∂éœ=πîx#πîüx'), 'a valid protocol-relative IRI Reference');
      assert.isTrue(validate('/âππ'), 'a valid relative IRI Reference');
      assert.isTrue(validate('âππ'), 'a valid IRI Reference');
      assert.isTrue(validate('#ƒrägmênt'), 'a valid IRI fragment');
      assert.isFalse(validate('\\\\WINDOWS\\filëßåré'), 'an invalid IRI Reference');
      assert.isFalse(validate('#ƒräg\\mênt'), 'an invalid IRI fragment');
    });
    it('should validate format: \'email\'', function () {
      const validate = compiler.compile({
        format: 'email'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('john.doe@example.com'), 'a valid email address');
      assert.isFalse(validate('2962'), 'an invalid email address');
    });
    it('should validate format: \'email--full\'', function () {
      const validate = compiler.compile({
        format: 'email--full'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('john.doe@example.com'), 'a valid email address');
      assert.isFalse(validate('2962'), 'an invalid email address');
    });
    it('should validate format: \'idn-email\'', function () {
      const validate = compiler.compile({
        format: 'idn-email'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('실례@실례.테스트'), 'a valid idn e-mail (example@example.test in Hangul)');
      assert.isFalse(validate('2962'), 'an invalid idn e-mail address');
    });

  });

  describe('#formatPointer()', function () {
    it('should validate format: \'json-pointer\'', function () {
      const validate = compiler.compile({
        format: 'json-pointer'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('/foo/bar~0/baz~1/%a'), 'a valid JSON-pointer');
      assert.isFalse(validate('/foo/bar~'), 'not a valid JSON-pointer (~ not escaped)');
      assert.isTrue(validate('/foo//bar'), 'valid JSON-pointer with empty segment');
      assert.isTrue(validate('/foo/bar/'), 'valid JSON-pointer with the last empty segment');
      assert.isTrue(validate(''), 'valid JSON-pointer as stated in RFC 6901 #1');
      assert.isTrue(validate('/foo'), 'valid JSON-pointer as stated in RFC 6901 #2');
      assert.isTrue(validate('/foo/0'), 'valid JSON-pointer as stated in RFC 6901 #3');
      assert.isTrue(validate('/'), 'valid JSON-pointer as stated in RFC 6901 #4');
      assert.isTrue(validate('/a~1b'), 'valid JSON-pointer as stated in RFC 6901 #5');
      assert.isTrue(validate('/c%d'), 'valid JSON-pointer as stated in RFC 6901 #6');
      assert.isTrue(validate('/e^f'), 'valid JSON-pointer as stated in RFC 6901 #7');
      assert.isTrue(validate('/g|h'), 'valid JSON-pointer as stated in RFC 6901 #8');
      assert.isTrue(validate('/i\\j'), 'valid JSON-pointer as stated in RFC 6901 #9');
      assert.isTrue(validate('/k\"l'), 'valid JSON-pointer as stated in RFC 6901 #10');
      assert.isTrue(validate('/ '), 'valid JSON-pointer as stated in RFC 6901 #11');
      assert.isTrue(validate('/m~0n'), 'valid JSON-pointer as stated in RFC 6901 #12');
      assert.isTrue(validate('/foo/-'), 'valid JSON-pointer used adding to the last array position');
      assert.isTrue(validate('/foo/-/bar'), 'valid JSON-pointer (- used as object member name)');
      assert.isTrue(validate('/~1~0~0~1~1'), 'valid JSON-pointer (multiple escaped characters)');
      assert.isTrue(validate('/~1.1'), 'valid JSON-pointer (escaped with fraction part) #1');
      assert.isTrue(validate('/~0.1'), 'valid JSON-pointer (escaped with fraction part) #2');
      assert.isFalse(validate('#'), 'not a valid JSON-pointer (URI Fragment Identifier) #1');
      assert.isFalse(validate('#/'), 'not a valid JSON-pointer (URI Fragment Identifier) #2');
      assert.isFalse(validate('#a'), 'not a valid JSON-pointer (URI Fragment Identifier) #3');
      assert.isFalse(validate('/~0~'), 'not a valid JSON-pointer (some escaped, but not all) #1');
      assert.isFalse(validate('/~0/~'), 'not a valid JSON-pointer (some escaped, but not all) #2');
      assert.isFalse(validate('/~2'), 'not a valid JSON-pointer (wrong escape character) #1');
      assert.isFalse(validate('/~-1'), 'not a valid JSON-pointer (wrong escape character) #2');
      assert.isFalse(validate('/~~'), 'not a valid JSON-pointer (multiple characters not escaped)');
      assert.isFalse(validate('a'), 'not a valid JSON-pointer (isn\'t empty nor starts with /) #1');
      assert.isFalse(validate('0'), 'not a valid JSON-pointer (isn\'t empty nor starts with /) #2');
      assert.isFalse(validate('a/a'), 'not a valid JSON-pointer (isn\'t empty nor starts with /) #3');
    });
    it('should validate format: \'relative-json-pointer\'', function () {
      const validate = compiler.compile({
        format: 'relative-json-pointer'
      });

      assert.isTrue(validate(undefined), 'undefined is true');
      assert.isTrue(validate(null), 'null is true');
      assert.isTrue(validate('1'), 'a valid upwards RJP');
      assert.isTrue(validate('0/foo/bar'), 'a valid downwards RJP');
      assert.isTrue(validate('2/0/baz/1/zip'), 'a valid up and then down RJP, with array index');
      assert.isTrue(validate('0#'), 'a valid RJP taking the member or index name');
      assert.isFalse(validate('/foo/bar'), 'an invalid RJP that is a valid JSON Pointer');
    });
    it('should validate format: \'json-pointer-uri-fragment\'', function () {
      const validate = compiler.compile({
        format: 'json-pointer-uri-fragment'
      });
      assert.isTrue(validate('#/$deps'));
      assert.isFalse(validate('#name'));
    });
  });

});
