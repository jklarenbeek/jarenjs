// Jaren JSLT adaptor for benchmark/jslt.js.
//
// Runtime scenarios compile stylesheet objects once. The compile probe
// starts from JSON text and includes JSON.parse, matching the query
// benchmark's methodology and the format's transport representation.

import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import { createTypeTestCompiler } from '@jarenjs/validate/query';

const IDENTITY_DOC = [];

const SURGICAL_DOC = [
  {
    match: '$..price',
    body: { $mul: ['$', 1.21] },
  },
];

const RESHAPE_DOC = {
  $jslt: '0.1',
  rules: [
    {
      match: '$',
      body: {
        toc: [{
          $apply: ['$.store.book[*]', 'toc'],
        }],
        body: [{
          $apply: ['$.store.book[*]', 'render'],
        }],
      },
    },
    {
      mode: 'toc',
      match: '$.store.book[*]',
      body: {
        id: { $default: ['$.isbn', '$.title'] },
        label: '$.title',
      },
    },
    {
      mode: 'render',
      match: '$.store.book[*]',
      body: {
        title: '$.title',
        author: '$.author',
        price: '$.price',
      },
    },
  ],
};

const ANNOTATE_DOC = {
  $jslt: '0.1',
  unmatched: 'fresh',
  rules: [
    {
      match: {
        schema: {
          type: 'object',
          required: ['isbn', 'title', 'author', 'price'],
        },
      },
      body: {
        category: '$.category',
        author: '$.author',
        title: '$.title',
        isbn: '$.isbn',
        price: '$.price',
        label: { $concat: ['$.title', ' by ', '$.author'] },
      },
    },
  ],
};

const DOCUMENTS = {
  identity: IDENTITY_DOC,
  surgical: SURGICAL_DOC,
  reshape: RESHAPE_DOC,
  annotate: ANNOTATE_DOC,
};

function scenario(doc, options = undefined) {
  return {
    source: JSON.stringify(doc),
    compile: () => compileJsltStylesheet(doc, options),
    run: (compiled, data) => compiled(data),
  };
}

export async function load() {
  const compileTypeTest = createTypeTestCompiler();
  const typedOptions = { compileTypeTest };

  return {
    key: 'jaren',
    name: 'Jaren JSLT',
    isAsync: false,
    prepare: (document) => document,
    scenarios: {
      identity: scenario(IDENTITY_DOC),
      surgical: scenario(SURGICAL_DOC),
      reshape: scenario(RESHAPE_DOC),
      annotate: scenario(ANNOTATE_DOC, typedOptions),
    },
    compileBench: (sources) => {
      const texts = sources.map((key) => JSON.stringify(DOCUMENTS[key]));
      return {
        fn: () => {
          for (let i = 0; i < texts.length; i++) {
            compileJsltStylesheet(
              JSON.parse(texts[i]),
              sources[i] === 'annotate' ? typedOptions : undefined);
          }
        },
        perCall: texts.length,
      };
    },
  };
}
