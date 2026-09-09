//@ts-check
import { writeFileSync } from 'node:fs';
import { createChatClient, REFINEMENT_PATCH_SCHEMA } from '@jarenjs/ai';
import { JarenValidator } from '@jarenjs/validate';
import { readAiEnv } from './lib/env.js';
const live = process.argv.includes('--live'), env = readAiEnv();
const full = REFINEMENT_PATCH_SCHEMA;
const conditional = { ...full, items: {
  type: 'object', required: ['op', 'path'],
  properties: { op: { enum: ['add', 'replace', 'remove'] }, path: { type: 'string' }, value: {} },
  additionalProperties: false,
  anyOf: full.items.oneOf.map((branch) => ({ properties: { op: branch.properties.op, path: branch.properties.path } })),
  allOf: full.items.oneOf.map((branch) => ({ if: { properties: { op: branch.properties.op, path: branch.properties.path } }, then: branch })),
} };
const checked = new JarenValidator({ collectErrors: true, skipErrors: false }).compile(full);
const good = [{ op: 'add', path: '/goal/progress/-', value: { note: 'Verified 42 rows', evidence: 'tool counted 42 rows' } }];
const rows = [];
for (const [syntax, schema] of [['oneOf', full], ['if-then', conditional]]) {
  if (live && (!env.live || rows.length >= env.maxCalls)) {
    rows.push({ syntax, outcome: 'skipped', reason: env.reason ?? 'call ceiling' }); continue;
  }
  let schemaSent = false;
  const client = createChatClient({ provider: live ? env.provider : 'openrouter', model: live ? env.model : 'fixture',
    apiKey: live ? env.apiKey : 'fixture', baseUrl: live ? env.baseUrl : undefined, retry: { attempts: 1 },
    fetch: async (url, init) => {
      const body = JSON.parse(String(init.body));
      schemaSent = JSON.stringify(body.response_format?.json_schema?.schema) === JSON.stringify(schema);
      if (!schemaSent) throw new Error('probe did not send the declared schema');
      return live ? fetch(url, init) : new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(good) } }] }));
    } });
  const start = performance.now();
  try {
    const result = await client.complete({ messages: [{ role: 'user', content:
      'Return ONLY a JSON Patch array adding one progress entry at /goal/progress/-. The tool counted 42 rows. Progress uses note and evidence. Do not add any memory or skill.' }],
    responseFormat: { name: 'refinement', strict: false, schema },
    temperature: 0, maxTokens: 1024, reasoning: { max_tokens: 256 }, signal: AbortSignal.timeout(30000) });
    const value = JSON.parse(result.message.content), valid = checked(value).valid;
    rows.push({ syntax, outcome: valid ? 'valid' : 'rejected-full-schema', acceptedRequest: true, schemaSent,
      fullValid: valid, elapsedMs: live ? Math.round(performance.now() - start) : 0, usage: result.usage ?? null });
  }
  catch (error) {
    // Never publish provider error text: it can include request credentials.
    rows.push({ syntax, outcome: 'failed', code: typeof error?.code === 'string' ? error.code : 'DECODE_OR_TRANSPORT', elapsedMs: Math.round(performance.now() - start) });
  }
}
const result = { version: 1, mode: live ? 'live' : 'scripted', provider: live ? env.provider : 'fixture',
  model: live ? env.model : 'fixture', strict: false, requests: rows.filter((row) => row.outcome !== 'skipped').length,
  conclusion: 'Use full oneOf in non-strict mode; local full-schema validation is mandatory. One trial per syntax does not prove provider grammar enforcement.', rows };
writeFileSync(new URL(`./patch-decoding-${live ? 'live' : 'scripted'}.json`, import.meta.url), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
