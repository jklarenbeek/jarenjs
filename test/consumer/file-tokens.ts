import { createFileTokenRegistry, type FileTokenOptions } from '@jarenjs/app/file-tokens';
const options: FileTokenOptions = { now: () => 1000, mintToken: () => 'suffix', maxFiles: 2, ttlMs: 100 };
const files = createFileTokenRegistry(options);
const tokens: readonly string[] = files.register([new File(['a'], 'a.txt')]);
const taken: File | null = files.take(tokens[0]);
const released: number = files.release(tokens);
const bytes: number = files.stats().bytes;
const extracted: readonly string[] = files.extract({ target: { files: [] } });
void [taken, released, bytes, extracted];
// @ts-expect-error files are native File objects
files.register(['a.txt']);
// @ts-expect-error token identity is a string
files.take(1);
// @ts-expect-error time is a synchronous host function
createFileTokenRegistry({ now: async () => 1 });
files.dispose();
