import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import {
  CONST_TICKS_SECOND,
  CONST_TICKS_HOUR,
  CONST_TICKS_DAY,
  CONST_TIME_INSERTDATE,
  CONST_DATE_APPENDTIME,
  isDateType,
  isDateishType,
  isLeapYear,
  isDateOnlyInRange,
  isDateOnlyRFC3339,
  isTimeOnlyInRange,
  isTimeOnlyRFC3339,
  isDateTimeRFC3339,
  getDateTypeOfDateOnlyRFC3339,
  getDateTypeOfTimeOnlyRFC3339,
  getDateTypeOfDateTimeRFC3339,
  isValidDuration,
  isValidISODateTime,
  isValidISOTime,
  getDateTypeOfISODateTime,
  getDateTypeOfISOTime,
} from '@jarenjs/core/dates';

describe('Date Constants', () => {
  it('should have correct tick values', () => {
    assert.deepEqual(CONST_TICKS_SECOND, 1000);
    assert.deepEqual(CONST_TICKS_HOUR, 3600000);
    assert.deepEqual(CONST_TICKS_DAY, 86400000);
  });

  it('should have correct insert/append constants', () => {
    assert.deepEqual(CONST_TIME_INSERTDATE, '1970-01-01T');
    assert.deepEqual(CONST_DATE_APPENDTIME, 'T00:00:00Z');
  });
});

describe('isDateType', () => {
  it('should return true for Date objects', () => {
    assert.isTrue(isDateType(new Date()));
    assert.isTrue(isDateType(new Date('2024-01-01')));
  });

  it('should return false for non-Date values', () => {
    assert.isFalse(isDateType('2024-01-01'));
    assert.isFalse(isDateType(1704067200000));
    assert.isFalse(isDateType(null));
    assert.isFalse(isDateType(undefined));
    assert.isFalse(isDateType({}));
  });
});

describe('isDateishType', () => {
  it('should return true for Date objects', () => {
    assert.isTrue(isDateishType(new Date()));
  });

  it('should return true for date strings', () => {
    assert.isTrue(isDateishType('2024-01-01'));
    assert.isTrue(isDateishType('2024-01-01T00:00:00Z'));
  });

  it('should return false for invalid date strings', () => {
    assert.isFalse(isDateishType('not a date'));
    assert.isFalse(isDateishType(''));
  });
});

describe('isLeapYear', () => {
  it('should return true for leap years', () => {
    assert.isTrue(isLeapYear(2000));
    assert.isTrue(isLeapYear(2020));
    assert.isTrue(isLeapYear(2024));
  });

  it('should return false for non-leap years', () => {
    assert.isFalse(isLeapYear(1900));
    assert.isFalse(isLeapYear(2023));
    assert.isFalse(isLeapYear(2025));
  });
});

describe('isDateOnlyInRange', () => {
  it('should return true for valid dates', () => {
    assert.isTrue(isDateOnlyInRange(2024, 1, 1));
    assert.isTrue(isDateOnlyInRange(2024, 12, 31));
    assert.isTrue(isDateOnlyInRange(2024, 2, 29)); // leap year
  });

  it('should return false for invalid dates', () => {
    assert.isFalse(isDateOnlyInRange(2024, 13, 1));
    assert.isFalse(isDateOnlyInRange(2024, 0, 1));
    assert.isFalse(isDateOnlyInRange(2024, 1, 32));
    assert.isFalse(isDateOnlyInRange(2023, 2, 29)); // not leap year
  });
});

describe('isDateOnlyRFC3339', () => {
  it('should return true for valid RFC 3339 dates', () => {
    assert.isTrue(isDateOnlyRFC3339('2024-01-15'));
    assert.isTrue(isDateOnlyRFC3339('2024-12-31'));
  });

  it('should return false for invalid dates', () => {
    assert.isFalse(isDateOnlyRFC3339('2024-13-15'));
    assert.isFalse(isDateOnlyRFC3339('2024-01-32'));
    assert.isFalse(isDateOnlyRFC3339('not a date'));
  });

  it('should return false for non-string values', () => {
    assert.isFalse(isDateOnlyRFC3339(null));
    assert.isFalse(isDateOnlyRFC3339(20240115));
  });
});

describe('isTimeOnlyInRange', () => {
  it('should return true for valid times', () => {
    assert.isTrue(isTimeOnlyInRange(12, 30, 45));
    assert.isTrue(isTimeOnlyInRange(0, 0, 0));
    assert.isTrue(isTimeOnlyInRange(23, 59, 59));
  });

  it('should return true for valid leap second', () => {
    assert.isTrue(isTimeOnlyInRange(23, 59, 60, 0, 0, 1)); // UTC leap second
  });

  it('should return false for invalid times', () => {
    assert.isFalse(isTimeOnlyInRange(24, 0, 0));
    assert.isFalse(isTimeOnlyInRange(12, 60, 0));
    assert.isFalse(isTimeOnlyInRange(12, 30, 61));
  });
});

describe('isTimeOnlyRFC3339', () => {
  it('should return true for valid RFC 3339 times', () => {
    // RFC 3339 requires timezone offset or Z
    assert.isTrue(isTimeOnlyRFC3339('12:30:45Z'));
    assert.isTrue(isTimeOnlyRFC3339('12:30:45+01:00'));
    assert.isTrue(isTimeOnlyRFC3339('12:30:45-05:00'));
    assert.isTrue(isTimeOnlyRFC3339('12:30:45.123Z'));
    assert.isTrue(isTimeOnlyRFC3339('12:30:45.123456+01:30'));
  });

  it('should return false for times without timezone (invalid per RFC 3339)', () => {
    assert.isFalse(isTimeOnlyRFC3339('12:30:45')); // missing timezone
  });

  it('should return false for invalid times', () => {
    assert.isFalse(isTimeOnlyRFC3339('25:00:00Z'));
    assert.isFalse(isTimeOnlyRFC3339('12:60:00Z'));
    assert.isFalse(isTimeOnlyRFC3339('not a time'));
  });
});

describe('isDateTimeRFC3339', () => {
  it('should return true for valid RFC 3339 date-times', () => {
    assert.isTrue(isDateTimeRFC3339('2024-01-15T12:30:45Z'));
    assert.isTrue(isDateTimeRFC3339('2024-01-15T12:30:45+01:00'));
    assert.isTrue(isDateTimeRFC3339('2024-01-15 12:30:45Z'));
  });

  it('should return false for invalid date-times', () => {
    assert.isFalse(isDateTimeRFC3339('2024-01-15'));
    assert.isFalse(isDateTimeRFC3339('12:30:45Z'));
    assert.isFalse(isDateTimeRFC3339('not a datetime'));
  });
});

describe('getDateTypeOfDateOnlyRFC3339', () => {
  it('should return Date for valid date string', () => {
    const result = getDateTypeOfDateOnlyRFC3339('2024-01-15');
    assert.isTrue(result instanceof Date);
    assert.deepEqual(result.getUTCFullYear(), 2024);
  });

  it('should return default for invalid date string', () => {
    assert.deepEqual(getDateTypeOfDateOnlyRFC3339('invalid', 'default'), 'default');
    assert.deepEqual(getDateTypeOfDateOnlyRFC3339('invalid'), undefined);
  });
});

describe('getDateTypeOfTimeOnlyRFC3339', () => {
  it('should return Date for valid time string', () => {
    const result = getDateTypeOfTimeOnlyRFC3339('12:30:45Z');
    assert.isTrue(result instanceof Date);
  });

  it('should return default for invalid time string', () => {
    assert.deepEqual(getDateTypeOfTimeOnlyRFC3339('invalid', 'default'), 'default');
  });
});

describe('getDateTypeOfDateTimeRFC3339', () => {
  it('should return Date for valid datetime string', () => {
    const result = getDateTypeOfDateTimeRFC3339('2024-01-15T12:30:45Z');
    assert.isTrue(result instanceof Date);
    assert.deepEqual(result.getUTCFullYear(), 2024);
  });

  it('should return default for invalid datetime string', () => {
    assert.deepEqual(getDateTypeOfDateTimeRFC3339('invalid', 'default'), 'default');
  });
});

describe('isValidDuration', () => {
  it('should return true for valid durations', () => {
    assert.isTrue(isValidDuration('P1Y2M3DT4H5M6S'));
    assert.isTrue(isValidDuration('P1W'));
    assert.isTrue(isValidDuration('PT1H'));
    assert.isTrue(isValidDuration('P1Y'));
    assert.isTrue(isValidDuration('PT1H30M'));
  });

  it('should return false for invalid durations', () => {
    assert.isFalse(isValidDuration('P')); // empty duration
    assert.isFalse(isValidDuration('1Y')); // missing P
    assert.isFalse(isValidDuration(''));
  });

  it('should return false for non-string values', () => {
    assert.isFalse(isValidDuration(null));
    assert.isFalse(isValidDuration(123));
  });
});

describe('isValidISODateTime', () => {
  it('should return true for valid ISO date-times', () => {
    assert.isTrue(isValidISODateTime('2024-01-15T12:30:00'));
    assert.isTrue(isValidISODateTime('2024-01-15T12:30:00Z'));
    assert.isTrue(isValidISODateTime('2024-01-15T12:30:00+01:00'));
    assert.isTrue(isValidISODateTime('2024-01-15 12:30:00'));
  });

  it('should return false for invalid ISO date-times', () => {
    assert.isFalse(isValidISODateTime('2024-13-15T12:30:00'));
    assert.isFalse(isValidISODateTime('2024-01-15T25:00:00'));
  });
});

describe('isValidISOTime', () => {
  it('should return true for valid ISO times', () => {
    assert.isTrue(isValidISOTime('12:30:00'));
    assert.isTrue(isValidISOTime('12:30:00Z'));
    assert.isTrue(isValidISOTime('12:30:00+01:00'));
  });

  it('should return false for invalid ISO times', () => {
    assert.isFalse(isValidISOTime('25:00:00'));
    assert.isFalse(isValidISOTime('12:60:00'));
  });
});

describe('getDateTypeOfISODateTime', () => {
  it('should return Date for valid ISO datetime', () => {
    const result = getDateTypeOfISODateTime('2024-01-15T12:30:00Z');
    assert.isTrue(result instanceof Date);
  });

  it('should return default for invalid input', () => {
    assert.deepEqual(getDateTypeOfISODateTime('invalid', 'default'), 'default');
  });
});

describe('getDateTypeOfISOTime', () => {
  it('should return Date for valid ISO time', () => {
    const result = getDateTypeOfISOTime('12:30:00Z');
    assert.isTrue(result instanceof Date);
  });

  it('should return default for invalid input', () => {
    assert.deepEqual(getDateTypeOfISOTime('invalid', 'default'), 'default');
  });
});
