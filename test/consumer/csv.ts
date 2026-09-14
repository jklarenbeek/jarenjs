import { stringifyCsv, stringifyCsvChunks, createCsvRowFormatter, type CsvWriterOptions } from '@jarenjs/josl/csv';
import { stringifyCsvStream, createCsvStreamWriter, CsvStreamWriter } from '@jarenjs/josl/csv-stream';
const policy: CsvWriterOptions = { neutralizeFormulas: true, fields: ['=heading'], quote: '"' };
const whole: string = stringifyCsv([], policy);
const lines: Iterable<string> = stringifyCsvChunks([], policy);
const streamed: AsyncIterable<string> = stringifyCsvStream([], { ...policy, signal: new AbortController().signal });
createCsvRowFormatter(policy).tail();
createCsvStreamWriter({ ...policy, onChunk: (text: string) => { void text; } }).end();
new CsvStreamWriter(policy).write(['=value']);
void [whole, lines, streamed];
// @ts-expect-error explicit policy is boolean
stringifyCsv([], { neutralizeFormulas: 'true' });
// @ts-expect-error async entry shares the same policy type
stringifyCsvStream([], { neutralizeFormulas: 1 });
// @ts-expect-error incremental entry shares the same policy type
createCsvStreamWriter({ neutralizeFormulas: 'true' });
