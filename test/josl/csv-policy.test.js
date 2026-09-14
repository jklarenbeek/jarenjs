import { describe, it } from 'node:test';
import { qualifyCsvPolicy, qualifyCsvDialects, qualifyCsvWriters } from '../consumer/csv.js';

describe('CSV spreadsheet export policy through public packages', () => {
  it('preserves default bytes and transforms the seven prefixes, headers and converted numbers only when selected', qualifyCsvPolicy);
  it('applies the policy before custom quoting and preserves explicit no-quote behavior', qualifyCsvDialects);
  it('agrees across whole, iterable, async and incremental writers and arbitrary byte splits', qualifyCsvWriters);
});
