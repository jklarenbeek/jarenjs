//@ts-check

/**
 * Hand-written checks of RFC 5545's ABNF (§3.1, §3.2, §3.3, §3.8) for
 * every property the writer emits, one unfolded content line at a time.
 * Each property's value is held to its value type's rule and each
 * parameter to the values the RFC lists for it.
 */

import assert from 'node:assert';

const NAME = /^[A-Za-z0-9-]+$/;
const DATE = '\\d{8}';
const TIME = '\\d{6}';
const DATE_TIME = `${DATE}T${TIME}Z?`;
const UTC = `${DATE}T${TIME}Z`;
// dur-value = ["+" / "-"] "P" (dur-date / dur-time / dur-week); dur-hour = 1*DIGIT "H" [dur-minute] ...
const DUR_TIME = 'T(?:\\d+H(?:\\d+M(?:\\d+S)?)?|\\d+M(?:\\d+S)?|\\d+S)';
const DURATION = `P(?:\\d+D(?:${DUR_TIME})?|${DUR_TIME}|\\d+W)`;
const PERIOD = `${DATE_TIME}/(?:${DATE_TIME}|${DURATION})`;
// TEXT = *(TSAFE-CHAR / ":" / DQUOTE / ESCAPED-CHAR); ESCAPED-CHAR = "\\" / "\;" / "\," / "\N" / "\n"
// eslint-disable-next-line no-control-regex -- the grammar names the control characters TEXT excludes
const TEXT = /^(?:[^\\;,\u0000-\u0008\u000A-\u001F\u007F]|\\[\\;,nN])*$/u;
const WEEKDAY = '(?:SU|MO|TU|WE|TH|FR|SA)';
const RECUR_PART = new RegExp(`^(?:FREQ=(?:SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY)|UNTIL=(?:${DATE}|${DATE_TIME})|COUNT=\\d+|INTERVAL=\\d+`
  + '|BYSECOND=\\d{1,2}(?:,\\d{1,2})*|BYMINUTE=\\d{1,2}(?:,\\d{1,2})*|BYHOUR=\\d{1,2}(?:,\\d{1,2})*'
  + `|BYDAY=(?:[+-]?\\d{1,2})?${WEEKDAY}(?:,(?:[+-]?\\d{1,2})?${WEEKDAY})*`
  + '|BYMONTHDAY=[+-]?\\d{1,2}(?:,[+-]?\\d{1,2})*|BYYEARDAY=[+-]?\\d{1,3}(?:,[+-]?\\d{1,3})*'
  + '|BYWEEKNO=[+-]?\\d{1,2}(?:,[+-]?\\d{1,2})*|BYMONTH=\\d{1,2}(?:,\\d{1,2})*|BYSETPOS=[+-]?\\d{1,3}(?:,[+-]?\\d{1,3})*'
  + `|WKST=${WEEKDAY})$`);

/** @param {string} source */
const whole = (source) => new RegExp(`^(?:${source})$`);

/** The value rule of each property, by its VALUE parameter (`''` when absent). */
const RULES = /** @type {Record<string, Record<string, RegExp | ((v: string) => boolean)>>} */ ({
  BEGIN: { '': /^(?:VCALENDAR|VEVENT|VFREEBUSY)$/ },
  END: { '': /^(?:VCALENDAR|VEVENT|VFREEBUSY)$/ },
  VERSION: { '': /^2\.0$/ },
  PRODID: { '': TEXT },
  METHOD: { '': /^PUBLISH$/ },
  UID: { '': TEXT },
  DTSTAMP: { '': whole(UTC) },
  DTSTART: { '': whole(DATE_TIME), DATE: whole(DATE) },
  DTEND: { '': whole(DATE_TIME), DATE: whole(DATE) },
  'RECURRENCE-ID': { '': whole(DATE_TIME), DATE: whole(DATE) },
  DURATION: { '': whole(DURATION) },
  RDATE: { '': whole(DATE_TIME), DATE: whole(DATE), PERIOD: whole(PERIOD) },
  EXDATE: { '': whole(DATE_TIME), DATE: whole(DATE) },
  RRULE: { '': (v) => v.split(';').every((part) => RECUR_PART.test(part)) && /^FREQ=/.test(v) },
  SUMMARY: { '': TEXT },
  DESCRIPTION: { '': TEXT },
  LOCATION: { '': TEXT },
  STATUS: { '': /^(?:TENTATIVE|CONFIRMED|CANCELLED)$/ },
  SEQUENCE: { '': /^\d+$/ },
  FREEBUSY: { '': whole(`${UTC}/(?:${UTC}|${DURATION})`) },
});

/** The parameters each property may carry, and the values each takes. */
const PARAMS = /** @type {Record<string, Record<string, RegExp>>} */ ({
  DTSTART: { VALUE: /^DATE$/ },
  DTEND: { VALUE: /^DATE$/ },
  'RECURRENCE-ID': { VALUE: /^DATE$/ },
  RDATE: { VALUE: /^(?:DATE|PERIOD)$/ },
  EXDATE: { VALUE: /^DATE$/ },
  FREEBUSY: { FBTYPE: /^(?:FREE|BUSY|BUSY-UNAVAILABLE|BUSY-TENTATIVE)$/ },
});

/**
 * Hold one unfolded content line to the grammar.
 * @param {{ name: string, params: Record<string, string>, value: string }} line
 */
export function checkGrammar(line) {
  assert.match(line.name, NAME);
  const rules = RULES[line.name];
  assert.ok(rules, `the writer emitted a property outside its subset: ${line.name}`);
  for (const [key, value] of Object.entries(line.params)) {
    const allowed = PARAMS[line.name]?.[key];
    assert.ok(allowed, `${line.name} carries no ${key} parameter`);
    // param-value = paramtext / quoted-string; every value written is a bare paramtext token
    // eslint-disable-next-line no-control-regex -- paramtext excludes the control characters
    assert.match(value, /^[^";:,\u0000-\u001F\u007F]*$/u);
    assert.match(value, allowed);
  }
  const rule = rules[line.params.VALUE ?? ''];
  assert.ok(rule, `${line.name} takes no VALUE=${line.params.VALUE}`);
  const ok = typeof rule === 'function' ? rule(line.value) : rule.test(line.value);
  assert.ok(ok, `${line.name}${line.params.VALUE ? `;VALUE=${line.params.VALUE}` : ''}:${line.value} breaks the ABNF`);
}
