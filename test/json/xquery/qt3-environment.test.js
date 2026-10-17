import { describe, it } from 'node:test';
import * as assert from 'node:assert';

import { convertEnvironmentText } from '../../../benchmark/tools/qt3-convert.js';
import { resolveCaseEnvironment } from '../../../benchmark/qt3-runner.js';

// The QT3 converter's reading of a case's environment, and the runner's
// registration of the decimal formats it declares (no submodule read: the
// environment is the text of numberformat87's, fn/format-number.xml).

const NUMBERFORMAT87 = `<environment>
  <decimal-format xmlns:a="http://a.ns/" name="a:test" decimal-separator="," grouping-separator="."/>
</environment>`;

describe('the QT3 converter reads an environment', () => {
  it('should keep a decimal format\'s own namespace declarations, and no other xmlns attribute', () => {
    assert.deepStrictEqual(convertEnvironmentText(NUMBERFORMAT87), {
      'decimal-format': [{
        'name': 'a:test', 'decimal-separator': ',', 'grouping-separator': '.',
        'namespaces': [{ prefix: 'a', uri: 'http://a.ns/' }],
      }],
    });
    assert.deepStrictEqual(
      convertEnvironmentText('<environment xmlns="http://www.w3.org/2010/09/qt-fots-catalog"><namespace prefix="p" uri="u"/></environment>'),
      { namespace: [{ prefix: 'p', uri: 'u' }] });
  });

  it('should let the runner register the format under its EQName', () => {
    const { environment } = resolveCaseEnvironment(convertEnvironmentText(NUMBERFORMAT87));
    const formats = environment.formats.options.decimalFormats;
    assert.deepStrictEqual(Object.keys(formats).sort(), ['Q{http://a.ns/}test', 'a:test']);
    assert.deepStrictEqual(formats['Q{http://a.ns/}test'], formats['a:test']);
    assert.strictEqual(Object.hasOwn(formats['a:test'], 'namespaces'), false);
  });
});
