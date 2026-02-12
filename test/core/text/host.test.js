import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  isValidMACAddr,
  isValidIPv4,
  isValidIPv6,
  isValidHostname,
  isValidIdnHostname,
  isValidUrl,
  isValidUrlFull,
  isValidUri,
  isValidUriFull,
  isValidUriRef,
  isValidUriRefFull,
  isValidUriTemplate,
  isValidIRI,
  isValidIRIRef,
} from '@jarenjs/core/text/host';

describe('isValidMACAddr', () => {
  it('should return true for valid MAC addresses with colons', () => {
    assert.isTrue(isValidMACAddr('00:1A:2B:3C:4D:5E'));
    assert.isTrue(isValidMACAddr('00:00:00:00:00:00'));
    assert.isTrue(isValidMACAddr('FF:FF:FF:FF:FF:FF'));
  });

  it('should return true for valid MAC addresses with hyphens', () => {
    assert.isTrue(isValidMACAddr('00-1A-2B-3C-4D-5E'));
    assert.isTrue(isValidMACAddr('00-00-00-00-00-00'));
  });

  it('should return true for valid MAC addresses without separators', () => {
    assert.isTrue(isValidMACAddr('001A2B3C4D5E'));
  });

  it('should return false for invalid MAC addresses', () => {
    assert.isFalse(isValidMACAddr('00:1A:2B:3C:4D')); // too short
    assert.isFalse(isValidMACAddr('00:1A:2B:3C:4D:5E:6F')); // too long
    assert.isFalse(isValidMACAddr('GG:HH:II:JJ:KK:LL')); // invalid hex
    assert.isFalse(isValidMACAddr(''));
  });
});

describe('isValidIPv4', () => {
  it('should return true for valid IPv4 addresses', () => {
    assert.isTrue(isValidIPv4('0.0.0.0'));
    assert.isTrue(isValidIPv4('192.168.1.1'));
    assert.isTrue(isValidIPv4('255.255.255.255'));
    assert.isTrue(isValidIPv4('10.0.0.1'));
    assert.isTrue(isValidIPv4('127.0.0.1'));
  });

  it('should return false for invalid IPv4 addresses', () => {
    assert.isFalse(isValidIPv4('256.1.1.1')); // octet too high
    assert.isFalse(isValidIPv4('192.168.1')); // too few octets
    assert.isFalse(isValidIPv4('192.168.1.1.1')); // too many octets
    assert.isFalse(isValidIPv4('192.168.1.'));
    assert.isFalse(isValidIPv4('192.168.a.1'));
    assert.isFalse(isValidIPv4(''));
  });
});

describe('isValidIPv6', () => {
  it('should return true for valid IPv6 addresses', () => {
    assert.isTrue(isValidIPv6('::1'));
    assert.isTrue(isValidIPv6('::'));
    assert.isTrue(isValidIPv6('2001:0db8:85a3:0000:0000:8a2e:0370:7334'));
    assert.isTrue(isValidIPv6('2001:db8:85a3::8a2e:370:7334'));
    assert.isTrue(isValidIPv6('fe80::1'));
  });

  it('should return true for IPv6 with embedded IPv4', () => {
    assert.isTrue(isValidIPv6('::ffff:192.168.1.1'));
  });

  it('should return false for invalid IPv6 addresses', () => {
    assert.isFalse(isValidIPv6('::g'));
    assert.isFalse(isValidIPv6(':::'));
    assert.isFalse(isValidIPv6('2001:db8:85a3::8a2e::7334')); // double ::
    assert.isFalse(isValidIPv6(''));
  });
});

describe('isValidHostname', () => {
  it('should return true for valid hostnames', () => {
    assert.isTrue(isValidHostname('example.com'));
    assert.isTrue(isValidHostname('sub.example.com'));
    assert.isTrue(isValidHostname('localhost'));
    assert.isTrue(isValidHostname('a.b'));
  });

  it('should return false for invalid hostnames', () => {
    assert.isFalse(isValidHostname('-example.com')); // starts with hyphen
    assert.isFalse(isValidHostname('example-.com')); // ends with hyphen
    assert.isFalse(isValidHostname('exam ple.com')); // space
    assert.isFalse(isValidHostname('')); // empty
  });

  it('should return false for hostnames over 255 chars', () => {
    assert.isFalse(isValidHostname('a'.repeat(256)));
  });
});

describe('isValidIdnHostname', () => {
  it('should return true for valid IDN hostnames', () => {
    assert.isTrue(isValidIdnHostname('example.com'));
    assert.isTrue(isValidIdnHostname('münchen.de'));
    assert.isTrue(isValidIdnHostname('xn--mnchen-3ya.de')); // punycode
  });

  it('should return false for invalid IDN hostnames', () => {
    assert.isFalse(isValidIdnHostname(''));
    assert.isFalse(isValidIdnHostname('a'.repeat(256))); // too long
  });
});

describe('isValidUrl', () => {
  it('should return true for valid URLs', () => {
    assert.isTrue(isValidUrl('https://example.com'));
    assert.isTrue(isValidUrl('http://example.com'));
    assert.isTrue(isValidUrl('https://example.com/path'));
  });

  it('should return false for invalid URLs', () => {
    assert.isFalse(isValidUrl('example.com')); // missing protocol
    assert.isFalse(isValidUrl(''));
  });
});

describe('isValidUrlFull', () => {
  it('should return true for valid URLs', () => {
    assert.isTrue(isValidUrlFull('https://example.com'));
    assert.isTrue(isValidUrlFull('http://example.com:8080/path?query=1'));
  });

  it('should handle complex URLs', () => {
    assert.isTrue(isValidUrlFull('https://user:pass@example.com:8080/path?query=1#frag'));
  });
});

describe('isValidUri', () => {
  it('should return true for valid URIs', () => {
    assert.isTrue(isValidUri('http://example.com'));
    assert.isTrue(isValidUri('https://example.com/path'));
    assert.isTrue(isValidUri('ftp://files.example.com'));
  });

  it('should return false for invalid URIs', () => {
    assert.isFalse(isValidUri('not-a-uri'));
    assert.isFalse(isValidUri('#fragment-only'));
  });
});

describe('isValidUriFull', () => {
  it('should return true for valid URIs', () => {
    assert.isTrue(isValidUriFull('http://example.com'));
    assert.isTrue(isValidUriFull('https://example.com:8080/path'));
  });
});

describe('isValidUriRef', () => {
  it('should return true for valid URI references', () => {
    assert.isTrue(isValidUriRef('http://example.com'));
    assert.isTrue(isValidUriRef('/path/to/resource'));
    assert.isTrue(isValidUriRef('path/to/resource'));
    assert.isTrue(isValidUriRef('#fragment'));
  });
});

describe('isValidUriRefFull', () => {
  it('should return true for valid URI references', () => {
    assert.isTrue(isValidUriRefFull('http://example.com'));
    assert.isTrue(isValidUriRefFull('/path'));
  });
});

describe('isValidUriTemplate', () => {
  it('should return true for valid URI templates', () => {
    assert.isTrue(isValidUriTemplate('http://example.com/{id}'));
    assert.isTrue(isValidUriTemplate('http://example.com/{+path}'));
    assert.isTrue(isValidUriTemplate('http://example.com/{?query}'));
    assert.isTrue(isValidUriTemplate('http://example.com/{#fragment}'));
  });

  it('should return true for simple URIs (no templates)', () => {
    assert.isTrue(isValidUriTemplate('http://example.com'));
  });
});

describe('isValidIRI', () => {
  it('should return true for valid IRIs', () => {
    assert.isTrue(isValidIRI('http://example.com'));
    assert.isTrue(isValidIRI('https://example.com/path'));
  });

  it('should return true for IRIs with unicode', () => {
    assert.isTrue(isValidIRI('https://例え.jp/テスト'));
  });
});

describe('isValidIRIRef', () => {
  it('should return true for valid IRI references', () => {
    assert.isTrue(isValidIRIRef('http://example.com'));
    assert.isTrue(isValidIRIRef('/path'));
  });
});
