// JSONata transform-operator adaptor for benchmark/jslt.js.
//
// JSONata's `~> | location | update |` operator deep-copies the input and
// applies object updates at matching locations. That is a close fit for
// surgical updates and fresh annotation, but it cannot express JSLT's
// recursive template dispatch or mode-separated full reshaping. Such
// cells are reported as n/a rather than replaced with a different JSONata
// feature that would change the comparison.

import { createRequire } from 'node:module';
import jsonata from 'jsonata';

const require = createRequire(import.meta.url);
const VERSION = require('jsonata/package.json').version;

const IDENTITY_SOURCE = '$ ~> |$|{}|';
const SURGICAL_SOURCE =
  '$ ~> |**[$exists(price)]|{"price": price * 1.21}|';
const ANNOTATE_SOURCE =
  '$ ~> |**[$exists(isbn) and $exists(title) and $exists(author) and $exists(price)]|'
  + '{"label": title & " by " & author}|';

const SOURCES = {
  identity: IDENTITY_SOURCE,
  surgical: SURGICAL_SOURCE,
  annotate: ANNOTATE_SOURCE,
};

function scenario(source) {
  return {
    source,
    compile: () => jsonata(source),
    run: (compiled, data) => compiled.evaluate(data),
  };
}

export async function load() {
  return {
    key: 'jsonata',
    name: `jsonata@${VERSION}`,
    isAsync: true,
    prepare: (document) => document,
    scenarios: {
      identity: scenario(IDENTITY_SOURCE),
      surgical: scenario(SURGICAL_SOURCE),
      reshape: null,
      annotate: scenario(ANNOTATE_SOURCE),
    },
    notes: {
      reshape: 'JSONata transforms update a copied input in place; they do not provide recursive rule dispatch or modes for a replacement reshape',
    },
    compileBench: (sources) => {
      const texts = sources.map((key) => SOURCES[key]);
      return {
        fn: () => {
          for (let i = 0; i < texts.length; i++)
            jsonata(texts[i]);
        },
        perCall: texts.length,
      };
    },
  };
}
