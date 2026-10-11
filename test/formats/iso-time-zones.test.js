import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import * as assert from '../assert.node.js';

import { JarenValidator } from '@jarenjs/validate';
import { dateTimeFormats, formatTesters } from '@jarenjs/formats';
import {
  isValidISOTime,
  getEpochOfISOTime,
  getEpochOfISODateTime,
} from '@jarenjs/core/dates';

// The `iso-time` offset is checked against the hour and minute of the
// offset itself, the compiler and the bare tester agree on every string,
// and a zone-less value compares the same on every host.

describe('iso-time offsets', function () {
  it('accepts every offset of a valid hour and minute, in both forms', function () {
    const compiled = new JarenValidator().addFormats(dateTimeFormats).compile({ format: 'iso-time' });
    for (const text of ['12:00:00+05:30', '12:00:00+05:45', '12:00:00-09:30', '12:00:00+23:59', '12:00:00-00:00']) {
      assert.isTrue(isValidISOTime(text), text);
      assert.isTrue(formatTesters['iso-time'](text), text);
      assert.isTrue(compiled(text), text);
    }
  });

  it('refuses an offset hour over 23 or an offset minute over 59, in both forms', function () {
    const compiled = new JarenValidator().addFormats(dateTimeFormats).compile({ format: 'iso-time' });
    for (const text of ['12:00:00+24:00', '12:00:00+99:00', '12:00:00+01:60', '12:00:00-24:30']) {
      assert.isFalse(isValidISOTime(text), text);
      assert.isFalse(formatTesters['iso-time'](text), text);
      assert.isFalse(compiled(text), text);
    }
  });

  it('reads an offset time as the instant it names', function () {
    assert.strictEqual(getEpochOfISOTime('12:00:00+05:30'), 23400000);
    assert.strictEqual(getEpochOfISOTime('12:00:00-09:30'), 77400000);
  });
});

describe('zone-less ISO values', function () {
  it('compare as UTC whatever the host zone is', function () {
    assert.strictEqual(getEpochOfISOTime('12:00:00'), 43200000);
    assert.strictEqual(getEpochOfISODateTime('2024-01-15 12:00:00'), 1705320000000);
    assert.strictEqual(getEpochOfISODateTime('2024-01-15T12:00:00.5'), 1705320000500);
  });

  it('give one verdict against a UTC bound in a zone east and a zone west of it', function () {
    const script = `
      import { JarenValidator } from '@jarenjs/validate';
      import { dateTimeFormats } from '@jarenjs/formats';
      const v = new JarenValidator().addFormats(dateTimeFormats);
      const time = v.compile({ format: 'iso-time', formatMinimum: '12:00:00Z' });
      const stamp = v.compile({ format: 'iso-date-time', formatMaximum: '2024-01-01T12:00:00Z' });
      console.log(JSON.stringify([time('12:00:00'), time('11:59:59'), stamp('2024-01-01T12:00:00'), stamp('2024-01-01T12:00:01')]));
    `;
    for (const zone of ['Asia/Tokyo', 'America/New_York', 'UTC']) {
      const out = execFileSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], {
        cwd: new URL('../..', import.meta.url),
        env: { ...process.env, TZ: zone },
        encoding: 'utf8',
      });
      assert.strictEqual(out.trim(), '[true,false,true,false]', zone);
    }
  });
});
