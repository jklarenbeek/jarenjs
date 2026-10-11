import { describe, it } from 'node:test';
import * as assert from '../assert.node.js';

import { JarenValidator } from '@jarenjs/validate';
import { stringFormats, formatTesters } from '@jarenjs/formats';

// `idn-email` is the `email` grammar widened to UTF-8; it is not a looser
// grammar, so anything `email` refuses for its shape is refused here too.

describe('idn-email format', function () {
  const validate = new JarenValidator().addFormats(stringFormats).compile({ format: 'idn-email' });

  it('accepts the ASCII addresses email accepts and the internationalized ones', function () {
    for (const text of ['user@example.com', 'user+tag@example.com', 'a@[1.2.3.4]', 'a@[IPv6:::1]', '"a b"@c.d', 'é@b.c', 'a@é.c', '\u{c2e4}\u{b840}@\u{c2e4}\u{b840}.\u{d14c}\u{c2a4}\u{d2b8}', '"é"@b.c']) {
      assert.isTrue(formatTesters['idn-email'](text), text);
      assert.isTrue(validate(text), text);
    }
  });

  it('refuses whitespace, control characters, empty labels and bad label edges', function () {
    for (const text of ['a b@c.d', 'a\n@b.c', 'a@b.c\n', 'a\u0001@b.c', 'a@b c.d', 'a@b.\u0000', 'a<@b.c', 'a..b@c.d', '.a@b.c', 'a@x..y', 'a@-b.c', 'a@b_c.d', 'a@é..c', 'a@-é.c', 'éé@b-.c', 'a@b.', 'a@.b', 'a@b', 'user', 'user@', '@b.c', 'a@b@c.d', '"a\nb"@c.d']) {
      assert.isFalse(formatTesters['idn-email'](text), JSON.stringify(text));
      assert.isFalse(validate(text), JSON.stringify(text));
    }
  });
});
