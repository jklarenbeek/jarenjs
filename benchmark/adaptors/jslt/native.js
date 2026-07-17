// Hand-written JavaScript baseline for benchmark/jslt.js.
//
// This is intentionally not a generic template engine: each scenario is
// the direct recursive transform an application author would write. It is
// the honesty floor for abstraction overhead. Identity performs a real
// deep clone as requested by that scenario; surgical uses copy-on-write
// sharing; annotate produces an entirely fresh tree.

const hasOwn = Object.hasOwn;

function setMember(out, key, value) {
  if (key === '__proto__') {
    Object.defineProperty(out, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  else {
    out[key] = value;
  }
}

function deepClone(value) {
  if (typeof value !== 'object' || value === null)
    return value;
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++)
      out[i] = deepClone(value[i]);
    return out;
  }
  const out = {};
  for (const key in value) {
    if (hasOwn(value, key))
      setMember(out, key, deepClone(value[key]));
  }
  return out;
}

function surgical(value) {
  if (typeof value !== 'object' || value === null)
    return value;
  if (Array.isArray(value)) {
    let out = null;
    for (let i = 0; i < value.length; i++) {
      const child = surgical(value[i]);
      if (child !== value[i] && out === null)
        out = value.slice();
      if (out !== null)
        out[i] = child;
    }
    return out === null ? value : out;
  }

  let out = null;
  for (const key in value) {
    if (!hasOwn(value, key))
      continue;
    const original = value[key];
    const child = key === 'price' && typeof original === 'number'
      ? original * 1.21
      : surgical(original);
    if (child !== original && out === null) {
      out = {};
      for (const copyKey in value) {
        if (hasOwn(value, copyKey))
          setMember(out, copyKey, value[copyKey]);
      }
    }
    if (out !== null)
      setMember(out, key, child);
  }
  return out === null ? value : out;
}

function reshape(data) {
  const books = data.store.book;
  const toc = new Array(books.length);
  const body = new Array(books.length);
  for (let i = 0; i < books.length; i++) {
    const book = books[i];
    toc[i] = {
      id: book.isbn ?? book.title,
      label: book.title,
    };
    body[i] = {
      title: book.title,
      author: book.author,
      price: book.price,
    };
  }
  return { toc, body };
}

function annotate(value) {
  if (typeof value !== 'object' || value === null)
    return value;
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++)
      out[i] = annotate(value[i]);
    return out;
  }

  const out = {};
  for (const key in value) {
    if (hasOwn(value, key))
      setMember(out, key, annotate(value[key]));
  }
  if (hasOwn(value, 'isbn')
    && hasOwn(value, 'title')
    && hasOwn(value, 'author')
    && hasOwn(value, 'price')) {
    out.label = value.title + ' by ' + value.author;
  }
  return out;
}

function scenario(fn, source) {
  return {
    source,
    compile: () => fn,
    run: (compiled, data) => compiled(data),
  };
}

export async function load() {
  return {
    key: 'native',
    name: 'native JS',
    isAsync: false,
    prepare: (document) => document,
    scenarios: {
      identity: scenario(deepClone, 'deepClone(data)'),
      surgical: scenario(surgical, 'recursive copy-on-write price transform'),
      reshape: scenario(reshape, 'direct TOC + body loops'),
      annotate: scenario(annotate, 'recursive fresh annotation transform'),
    },
    compileBench: null,
    notes: {
      compile: 'native scenarios are pre-written JavaScript functions and have no stylesheet compile phase',
    },
  };
}
