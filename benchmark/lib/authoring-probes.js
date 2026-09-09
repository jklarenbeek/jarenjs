//@ts-check
import { readFileSync } from 'node:fs';
import { createChatClient, programGate, PROGRAM_SCHEMA,
  PROGRAM_EXAMPLE, compileGate, STYLESHEET_EXAMPLE, stylesheetSystemMessage,
  createEnvironment, createProgramRunner } from '@jarenjs/ai';
import { compileJsonQuery } from '@jarenjs/json/query';
import { compileJsltStylesheet } from '@jarenjs/json/jslt';
import jslt from '@jarenjs/json/schemas/jaren-jslt.schema.json' with { type: 'json' };
import profile from '@jarenjs/json/schemas/jaren-jslt.authoring.schema.json' with { type: 'json' };
import { JarenValidator } from '@jarenjs/validate';
import { readAiEnv } from './env.js';
import { measureAuthoring, legacyAuthoringEvidence } from './authoring.js';

/** Identical prompts and gates for every host-supplied route. */
export const AUTHORING_PROBES = [
  { grammar: 'program', schema: PROGRAM_SCHEMA, gate: programGate({ compileQuery: compileJsonQuery, known: ['corpus'] }),
    document: PROGRAM_EXAMPLE,
    system: 'You author environment programs. The corpus slot contains JSON records, one per line. Use this grammar example: ' + JSON.stringify(PROGRAM_EXAMPLE),
    question: 'Author a program over the text slot corpus. Chunk by line, map each piece to its record as {id,value}, reduce to the numeric values, then answer. Return only the program JSON.',
    check: async (doc) => {
      const environment = createEnvironment();
      await environment.put('corpus', [3, 7].map((value) => JSON.stringify({ id: `r${value}`, value, padding: 'x'.repeat(2200) })).join('\n'), { kind: 'text' });
      const runner = createProgramRunner({ environment, compileQuery: compileJsonQuery,
        client: { complete: async ({ messages }) => {
          const text = messages.at(-1).content;
          const value = Number(/"value":(\d+)/.exec(text)?.[1]);
          return { message: { content: JSON.stringify({ id: `r${value}`, value }) } };
        } } });
      const result = await runner.run(doc);
      return result.ok && JSON.stringify(JSON.parse(result.answer.text)) === '[3,7]';
    } },
  { grammar: 'jslt', schema: profile,
    gate: [(doc) => new JarenValidator().compile(jslt)(doc), compileGate({ compile: compileJsltStylesheet })],
    document: STYLESHEET_EXAMPLE,
    system: stylesheetSystemMessage(''),
    question: 'Author a JSLT stylesheet with one root rule (match "$"), returning {total: sum of $.prices[*]}. Return only the stylesheet JSON.',
    check: (doc) => compileJsltStylesheet(doc)({ prices: [3, 7, 2] })?.total === 12 },
];

/** Run the existing long-horizon instrument's authoring-only mode.
 * @param {{ live: boolean, profiles?: string|null, trials?: number|null }} flags */
export async function authoringScorecard(flags) {
  const env = readAiEnv();
  const profiles = flags.profiles ? JSON.parse(readFileSync(flags.profiles, 'utf8')) : [
    { name: 'primary', provider: env.provider, model: env.model, baseUrl: env.baseUrl },
    { name: 'secondary', provider: env.provider, model: env.modelStrong, baseUrl: env.baseUrl },
  ];
  if (!Array.isArray(profiles) || profiles.length === 0) throw new TypeError('profiles must be a nonempty array');
  const legacy = JSON.parse(readFileSync(new URL('../../packages/website/public/benchmarks/long-horizon.json', import.meta.url), 'utf8'));
  const rows = [];
  let calls = 0;
  for (const route of profiles) {
    const sampling = { temperature: 0, maxTokens: 4096, reasoning: { max_tokens: 512 }, ...route.sampling };
    const spec = { ...route, sampling, deadlineMs: route.deadlineMs ?? 30000 };
    // Keys are resolved only here; the evidence writer sees a whitelist.
    const apiKey = route.keyEnv ? process.env[route.keyEnv] : env.apiKey;
    const available = Boolean(apiKey) || ['ollama', 'lmstudio'].includes(spec.provider);
    if (flags.live && (!available || !spec.model)) {
      rows.push({ profile: spec.name, outcome: 'skipped', reason: 'missing credential or model' });
      continue;
    }
    for (const probe of AUTHORING_PROBES) {
      for (let trial = 0; trial < (flags.trials ?? env.trials); trial++) {
        if (calls >= env.maxCalls) { rows.push({ profile: spec.name, outcome: 'skipped', reason: 'maxCalls' }); continue; }
        calls++;
        const client = flags.live
          ? createChatClient({ ...spec, apiKey, retry: { attempts: 1 } })
          : { endpoint: { provider: 'openrouter' }, complete: async () => ({
            message: { content: JSON.stringify(probe.grammar === 'jslt'
              ? [{ match: '$', body: { total: { $sum: '$.prices[*]' } } }] : probe.document) },
            usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50,
              completion_tokens_details: { reasoning_tokens: 0 } }, finishReason: 'stop',
          }) };
        let tick = 0;
        const attempts = await measureAuthoring({ ...probe, client, profile: flags.live ? spec
          : { ...spec, provider: 'scripted', model: 'fixture', providerVersion: '1' },
          messages: [{ role: 'system', content: probe.system }, { role: 'user', content: probe.question }],
          ...(flags.live ? {} : { clock: () => tick++, measuredAt: 'fixture' }),
        });
        rows.push(...attempts.map((row) => ({ trial, ...row })));
      }
    }
  }
  return { version: 1, mode: flags.live ? 'live' : 'deterministic',
    node: process.version, legacy: legacyAuthoringEvidence(legacy), rows };
}
