//@ts-check
/**
 * Copy the shared static assets from @jarenjs/website into this
 * package's public/ directory: the generated benchmark data (the
 * single source of truth stays `benchmark/website-data.js` writing into
 * the website package) and the logo. Run automatically by dev/build.
 */
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const websitePublic = join(here, '..', '..', 'website', 'public');
const publicDir = join(here, '..', 'public');

mkdirSync(publicDir, { recursive: true });

const benchmarks = join(websitePublic, 'benchmarks');
if (existsSync(benchmarks)) {
  cpSync(benchmarks, join(publicDir, 'benchmarks'), { recursive: true });
}
for (const file of ['jaren.svg']) {
  const source = join(websitePublic, file);
  if (existsSync(source)) cpSync(source, join(publicDir, file));
}
