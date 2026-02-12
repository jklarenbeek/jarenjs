// email (sources from json validator):
// http://stackoverflow.com/questions/201323/using-a-regular-expression-to-validate-an-email-address#answer-8829363
// http://www.w3.org/TR/html5/forms.html#valid-e-mail-address (search for 'willful violation')
const CONST_REGEXP_EMAIL_FAST = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;
export function isValidEmail(str) {
  return CONST_REGEXP_EMAIL_FAST.test(str);
}

const CONST_REGEXP_EMAIL_FULL = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i;
export function isValidEmailFull(str) {
  return CONST_REGEXP_EMAIL_FULL.test(str);
}

const CONST_REGEXP_IDNEMAIL = /^[^@]+@[^@]+\.[^@]+$/;
export function isValidIdnEmail(str) {
  return CONST_REGEXP_IDNEMAIL.test(str);
}
