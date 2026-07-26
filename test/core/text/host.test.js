import { describe, it } from 'node:test';
import * as assert from '../../assert.node.js';

import {
  isValidMACAddr,
  isValidIPv4,
  isValidIPv6,
  isValidHostname,
  isValidIdnHostname,
  isValidUrl,
  isValidUri,
  isValidUriRef,
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

  it('should accept any number of labels', () => {
    assert.isTrue(isValidIdnHostname('a.b'));
    assert.isTrue(isValidIdnHostname('www.sub.example.com'));
    assert.isTrue(isValidIdnHostname('a.b.c.d.e.f.g'));
    assert.isTrue(isValidIdnHostname('xn--r8jz45g.example.co.uk'));
    assert.isTrue(isValidIdnHostname('例え.テスト.example.jp'));
  });

  it('should reject a hyphen at either end of a label', () => {
    assert.isFalse(isValidIdnHostname('-a.com'));
    assert.isFalse(isValidIdnHostname('a-.com'));
    assert.isFalse(isValidIdnHostname('ab.a-'));
    assert.isFalse(isValidIdnHostname('ab.-a.com'));
  });

  it('should reject empty labels and over-long ones', () => {
    assert.isFalse(isValidIdnHostname('a..b'));
    assert.isFalse(isValidIdnHostname('example.'), 'a trailing root dot');
    assert.isFalse(isValidIdnHostname('.example'));
    assert.isTrue(isValidIdnHostname('x'.repeat(63) + '.com'));
    assert.isFalse(isValidIdnHostname('x'.repeat(64) + '.com'));
  });

  it('should accept every hostname that isValidHostname accepts', () => {
    // An IDN hostname is a hostname that may additionally carry U-labels,
    // so the ASCII grammar has to be a subset. It was not: the ACE shape
    // was checked with a whole-name pattern that only admitted two or
    // three labels, so `www.sub.example.com` failed here while passing
    // isValidHostname.
    const parts = ['a', 'ab', 'www', 'sub', 'example', 'com', 'co', 'uk', 'x9', '123'];
    for (const a of parts) {
      for (const b of parts) {
        for (const c of parts) {
          for (const name of [a, `${a}.${b}`, `${a}.${b}.${c}`, `${a}.${b}.${c}.com`]) {
            if (!isValidHostname(name)) continue;
            assert.isTrue(isValidIdnHostname(name),
              `${name} is a hostname but not an IDN hostname`);
          }
        }
      }
    }
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

describe('isValidUri', () => {
  it('should return true for valid URIs', () => {
    assert.isTrue(isValidUri('http://example.com'));
    assert.isTrue(isValidUri('https://example.com/path'));
    assert.isTrue(isValidUri('ftp://files.example.com'));
    assert.isTrue(isValidUri('https://example.com:8080/path'));
    assert.isTrue(isValidUri('mailto:foo@bar.com'), 'a non-hierarchical scheme');
    assert.isTrue(isValidUri('urn:isbn:0451450523'));
  });

  it('should return false for invalid URIs', () => {
    assert.isFalse(isValidUri('not-a-uri'));
    assert.isFalse(isValidUri('#fragment-only'));
    assert.isFalse(isValidUri('http://example.com:abc'), 'a non-numeric port');
    assert.isFalse(isValidUri('http://x/%zz'), 'malformed percent-encoding');
    assert.isFalse(isValidUri('http://x/a|b'), 'a character outside the grammar');
  });

  it('should reject the non-ASCII characters that make a string an IRI', () => {
    // RFC 3986 is an ASCII grammar throughout; the ucschar ranges are
    // what RFC 3987 adds on top of it.
    assert.isFalse(isValidUri('https://例え.jp/テスト'));
    assert.isFalse(isValidUri('http://x/é'));
    assert.isTrue(isValidIRI('https://例え.jp/テスト'), 'the same string is a valid IRI');
  });
});

describe('isValidUriRef', () => {
  it('should return true for valid URI references', () => {
    assert.isTrue(isValidUriRef('http://example.com'));
    assert.isTrue(isValidUriRef('/path/to/resource'));
    assert.isTrue(isValidUriRef('path/to/resource'));
    assert.isTrue(isValidUriRef('#fragment'));
    assert.isTrue(isValidUriRef(''), 'the empty reference');
    assert.isTrue(isValidUriRef('../a/b'));
  });

  it('should return false for malformed references', () => {
    assert.isFalse(isValidUriRef('a\\b'));
    assert.isFalse(isValidUriRef('<a>'));
    assert.isFalse(isValidUriRef('%2'));
    assert.isFalse(isValidUriRef('1http://x'), 'a colon in the first segment');
  });
});

describe('URI and IRI relate as sub- and superset', () => {
  it('accepts every URI as an IRI', () => {
    // RFC 3987 widens one character class of RFC 3986 and adds nothing
    // else, so a URI is an IRI by construction. The two answered from
    // unrelated patterns before they shared a scanner, and disagreed.
    const cases = [
      'http://example.com', 'https://example.com:8080/p?q=1#f', 'mailto:foo@bar.com',
      'urn:isbn:1', 'http://[::1]/x', 'a:', 'http://x/a%20b', '/path', 'path', '#f', '',
      '../a', 'http://user:pw@host/p', 'ftp://x/y', 'http://x/(a)', "http://x/a'b",
    ];
    for (const c of cases) {
      if (isValidUri(c))
        assert.isTrue(isValidIRI(c), `${JSON.stringify(c)} is a URI but not an IRI`);
      if (isValidUriRef(c))
        assert.isTrue(isValidIRIRef(c), `${JSON.stringify(c)} is a URI reference but not an IRI reference`);
    }
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
    assert.isTrue(isValidIRI('http://user:pw@example.com:8080/p?q=1#f'));
  });

  it('should return true for IRIs with unicode', () => {
    assert.isTrue(isValidIRI('https://例え.jp/テスト'));
  });

  it('should accept a scheme whose path is not hierarchical', () => {
    // ihier-part admits ipath-rootless and ipath-empty, so a scheme need
    // not be followed by "//" at all.
    assert.isTrue(isValidIRI('mailto:foo@bar.com'));
    assert.isTrue(isValidIRI('urn:uuid:6e8bc430-9c3a-11d9-9669-0800200c9a66'));
    assert.isTrue(isValidIRI('tel:+31-20-1234567'));
    assert.isTrue(isValidIRI('news:comp.lang.js'));
    assert.isTrue(isValidIRI('a:'), 'an empty path is a path');
  });

  it('should accept the bracketed host forms', () => {
    assert.isTrue(isValidIRI('http://[2001:0db8:85a3:0000:0000:8a2e:0370:7334]'));
    assert.isTrue(isValidIRI('http://[::1]/x'));
    assert.isTrue(isValidIRI('http://[v7.fe80::a]/x'), 'IPvFuture');
    assert.isFalse(isValidIRI('http://[::1/x'), 'an unclosed literal');
    assert.isFalse(isValidIRI('http://[not-an-address]/x'));
  });

  it('should reject an unbracketed IPv6 authority', () => {
    // The colons read as a port, which admits only digits.
    assert.isFalse(isValidIRI('http://2001:0db8:85a3:0000:0000:8a2e:0370:7334'));
  });

  it('should require a scheme', () => {
    assert.isFalse(isValidIRI('/abc'));
    assert.isFalse(isValidIRI('âππ'));
    assert.isFalse(isValidIRI('//example.com/a'));
  });

  it('should reject malformed percent-encoding', () => {
    // pct-encoded = "%" HEXDIG HEXDIG, so a truncated or non-hex escape
    // is not a character at all.
    for (const bad of ['%', '%A', '%AG', '%GA', '%%', 'a%']) {
      assert.isFalse(isValidIRI('http://x/' + bad), `path ${JSON.stringify(bad)}`);
    }
    assert.isTrue(isValidIRI('http://x/%41'));
    assert.isTrue(isValidIRI('http://x/a%20b'));
  });

  it('should reject characters outside every production', () => {
    for (const bad of ['\\', '<', '>', '{', '}', '|', '^', '"', '`', ' ']) {
      assert.isFalse(isValidIRI('http://x/a' + bad + 'b'), `path ${JSON.stringify(bad)}`);
    }
  });

  it('should place ucschar and iprivate by production', () => {
    // ucschar is iunreserved and so belongs anywhere; iprivate is
    // admitted by iquery alone.
    assert.isTrue(isValidIRI('http://x/\u{10000}'), 'a supplementary-plane ucschar');
    assert.isFalse(isValidIRI('http://x/\u{1FFFE}'), 'a noncharacter is not a ucschar');
    assert.isTrue(isValidIRI('http://x/?a='), 'iprivate in the query');
    assert.isFalse(isValidIRI('http://x/'), 'iprivate is not in a path');
    assert.isFalse(isValidIRI('http://x/#'), 'iprivate is not in a fragment');
  });

  it('should reject unpaired surrogates', () => {
    assert.isFalse(isValidIRI('http://x/\uD800'));
    assert.isFalse(isValidIRI('http://x/\uDC00'));
    assert.isFalse(isValidIRI('http://x/\uD800a'));
  });
});

describe('isValidIRIRef', () => {
  it('should return true for valid IRI references', () => {
    assert.isTrue(isValidIRIRef('http://example.com'));
    assert.isTrue(isValidIRIRef('/path'));
    assert.isTrue(isValidIRIRef('//example.com/a'), 'a network-path reference');
    assert.isTrue(isValidIRIRef('âππ'), 'a relative path');
    assert.isTrue(isValidIRIRef('#ƒrägmênt'), 'a bare fragment');
    assert.isTrue(isValidIRIRef(''), 'the empty reference');
    assert.isTrue(isValidIRIRef('../a/b'));
  });

  it('should reject a colon in the first segment of a relative reference', () => {
    // RFC 3986 section 4.2: such a segment would be read as a scheme.
    assert.isFalse(isValidIRIRef('1http://x'));
    assert.isFalse(isValidIRIRef('+http://x'));
    assert.isTrue(isValidIRIRef('./1http:x'), 'a later segment may hold a colon');
  });

  it('should apply the same character rules as isValidIRI', () => {
    assert.isFalse(isValidIRIRef('a\\b'));
    assert.isFalse(isValidIRIRef('<a>'));
    assert.isFalse(isValidIRIRef('a|b'));
    assert.isFalse(isValidIRIRef('%zz'));
    assert.isFalse(isValidIRIRef('#ƒräg\\mênt'));
  });
});
