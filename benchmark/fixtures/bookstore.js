// The RFC 9535 bookstore family shared by the JSON Query and JSLT
// benchmarks. Keeping one generator makes scaling, prices, ISBN coverage,
// and rating cardinalities identical across both tools.

/**
 * Return the RFC 9535 section 1.5 bookstore plus the ratings used by the
 * query-format join example.
 * @returns {object} four-book benchmark document
 */
export function makeBookstore() {
  return {
    store: {
      book: [
        { category: 'reference', author: 'Nigel Rees', title: 'Sayings of the Century', price: 8.95 },
        { category: 'fiction', author: 'Evelyn Waugh', title: 'Sword of Honour', price: 12.99 },
        { category: 'fiction', author: 'Herman Melville', title: 'Moby Dick', isbn: '0-553-21311-3', price: 8.99 },
        { category: 'fiction', author: 'J. R. R. Tolkien', title: 'The Lord of the Rings', isbn: '0-395-19395-8', price: 22.99 },
      ],
      bicycle: { color: 'red', price: 399 },
    },
    ratings: [
      { isbn: '0-395-19395-8', stars: 5 },
      { isbn: '0-553-21311-3', stars: 4 },
      { isbn: '0-000-00000-0', stars: 1 },
    ],
  };
}

/**
 * Return a deterministic scaled member of the bookstore family: n books
 * over 7 categories; 2 of 3 books carry an isbn, half of those are rated,
 * plus n/10 dangling ratings. The i/1e5 epsilon keeps every price unique
 * so engine sorts stay deterministic and order normalization never hides
 * a real mismatch (the JSLT tool rounds prices back to cents — it does
 * not sort, and JSONata's deep copy normalizes long binary tails).
 * @param {number} n - number of generated books
 * @returns {object} scaled benchmark document
 */
export function makeScaledBookstore(n) {
  const categories = [
    'reference', 'fiction', 'science', 'history',
    'poetry', 'travel', 'cooking',
  ];
  const book = [];
  const ratings = [];
  for (let i = 0; i < n; i++) {
    const item = {
      category: categories[i % 7],
      author: `Author ${i % 97}`,
      title: `Book ${i}`,
      price: (i * 7919) % 4000 / 100 + i / 1e5,
    };
    if (i % 3 !== 0) {
      item.isbn = `isbn-${i}`;
      if (i % 2 === 0)
        ratings.push({ isbn: item.isbn, stars: i % 5 + 1 });
    }
    book.push(item);
  }
  for (let i = 0; i < n / 10; i++)
    ratings.push({ isbn: `dangling-${i}`, stars: 3 });
  return {
    store: {
      book,
      bicycle: { color: 'red', price: 399 },
    },
    ratings,
  };
}

/**
 * Build the base document and, when requested, the 1k/10k scale members.
 * @param {boolean} scale - whether to include large documents
 * @param {number[]} [sizes=[1000, 10000]] - scale sizes
 * @returns {object[]} labeled benchmark documents
 */
export function makeBookstoreDocuments(scale, sizes = [1000, 10000]) {
  const base = makeBookstore();
  const documents = [{
    label: 'bookstore (4 books, 3 ratings)',
    books: 4,
    data: base,
  }];
  if (scale) {
    for (const n of sizes) {
      const data = makeScaledBookstore(n);
      documents.push({
        label: `bookstore (${n} books, ${data.ratings.length} ratings)`,
        books: n,
        data,
      });
    }
  }
  return documents;
}
