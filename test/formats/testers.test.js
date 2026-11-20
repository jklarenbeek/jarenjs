import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  stringFormats,
  jsonFormats,
  dateTimeFormats,
  numberFormats,
  geoFormats,
  formatTesters,
  stringFormatTesters,
  jsonFormatTesters,
  dateTimeFormatTesters,
  numberFormatTesters,
  integerFormatTesters,
  geoFormatTesters,
} from '@jarenjs/formats';

// The registry sync contract: testers.js is the single source of truth
// for format-name -> predicate bindings. Every compiler registry must
// stay in one-to-one correspondence with its tester group, so the
// validator's format compilers and @jarenjs/forms' preemptive field
// validation can never drift apart again (they did: 'iso-time' and the
// since-removed 'url--full' disagreed before this table existed).

describe('Format tester registry', function () {
  const groups = [
    ['stringFormats', stringFormats, stringFormatTesters],
    ['jsonFormats', jsonFormats, jsonFormatTesters],
    ['dateTimeFormats', dateTimeFormats, dateTimeFormatTesters],
    ['numberFormats', numberFormats, numberFormatTesters],
    ['geoFormats', geoFormats, geoFormatTesters],
  ];

  for (const [label, compilers, testers] of groups) {
    it(`should keep ${label} in sync with its tester group`, function () {
      const compilerNames = Object.keys(compilers).sort();
      const testerNames = Object.keys(testers).sort();
      assert.deepEqual(compilerNames, testerNames);
      for (const name of testerNames) {
        assert.isTrue(typeof testers[name] === 'function', `tester '${name}' is a function`);
        assert.isTrue(typeof compilers[name] === 'function', `compiler '${name}' is a function`);
      }
    });
  }

  it('should aggregate every group into formatTesters', function () {
    const all = groups.flatMap(([, , testers]) => Object.keys(testers));
    assert.deepEqual(Object.keys(formatTesters).sort(), [...new Set(all)].sort());
  });

  it("should accept timezone-less times for 'iso-time' but not for 'time'", function () {
    assert.isTrue(formatTesters['iso-time']('12:30:00'));
    assert.isTrue(formatTesters['iso-time']('12:30:00+01:00'));
    assert.isFalse(formatTesters['iso-time']('25:00:00'));
    assert.isTrue(formatTesters['time']('12:30:00Z'));
    assert.isFalse(formatTesters['time']('12:30:00'), 'RFC 3339 time requires an offset');
  });

  it("should test 'url' as a URI narrowed to the web schemes", function () {
    assert.isTrue(formatTesters['url']('http://example.com/'));
    assert.isTrue(formatTesters['url']('http://localhost:8080/x'), 'a single-label authority is a host');
    assert.isFalse(formatTesters['url']('ftp://example.com/'), 'not a web scheme');
    assert.isFalse(formatTesters['url']('example.com'), 'no scheme');
    assert.isFalse(formatTesters['url']('http://x/a|b'), 'a URL is a URI, so the grammar still applies');
    assert.isTrue(formatTesters['uri']('ftp://example.com/'), 'which uri accepts');
  });

  it('should test number formats against numbers', function () {
    assert.isTrue(formatTesters['int8'](127));
    assert.isFalse(formatTesters['int8'](128));
    assert.isTrue(formatTesters['uint32'](4294967295));
    assert.isFalse(formatTesters['uint32'](-1));
  });

  it('should name the integer formats, which test a bigint by their own range', function () {
    assert.deepEqual(Object.keys(integerFormatTesters), ['int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64']);
    for (const name of Object.keys(integerFormatTesters)) {
      assert.isTrue(numberFormatTesters[name] === integerFormatTesters[name], `${name} is one tester in both tables`);
      assert.isTrue(integerFormatTesters[name](0n) && integerFormatTesters[name](0), `${name} takes 0n and 0`);
    }
    assert.deepEqual(Object.keys(numberFormatTesters).filter((name) => !(name in integerFormatTesters)), ['float16', 'float32', 'float64', 'float', 'double']);
    assert.isTrue(integerFormatTesters['int64'](2n ** 63n - 1n));
    assert.isFalse(integerFormatTesters['int64'](2n ** 63n));
    assert.isFalse(integerFormatTesters['uint8'](256n));
    assert.isFalse(integerFormatTesters['uint64'](-1n));
    assert.isFalse(formatTesters['float'](5n), 'a floating point tester takes a number only');
  });
});
