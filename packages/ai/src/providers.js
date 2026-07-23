//@ts-check
/**
 * Provider endpoint resolution for OpenAI-compatible chat APIs.
 *
 * The bring-your-own-key reality of browser-side AI is three shapes:
 * a cloud aggregator key (OpenRouter) or a local runtime URL (Ollama,
 * LM Studio). All of them — and every other OpenAI-compatible server —
 * speak the same `/chat/completions` wire format, so one small client
 * covers the lot; the only per-provider knowledge needed is the base
 * URL convention, which lives here.
 *
 * No key ever leaves the caller's hands: resolution just turns
 * `{ provider, baseUrl, apiKey, model }` into a URL + headers pair.
 */

import { AiError } from './errors.js';

/**
 * The built-in providers. `custom` accepts any OpenAI-compatible base
 * URL (the caller must supply one). The local runtimes get `/v1`
 * appended automatically when the URL carries no path — pasting
 * `http://localhost:11434` just works.
 * @type {Record<string, { label: string, baseUrl: string | null, local: boolean }>}
 */
export const PROVIDERS = {
  openrouter: { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', local: false },
  ollama: { label: 'Ollama', baseUrl: 'http://localhost:11434/v1', local: true },
  lmstudio: { label: 'LM Studio', baseUrl: 'http://localhost:1234/v1', local: true },
  custom: { label: 'OpenAI-compatible', baseUrl: null, local: false },
};

/**
 * Resolve a provider configuration into a concrete chat endpoint.
 * @param {{ provider?: string, baseUrl?: string, apiKey?: string,
 *   model?: string, headers?: Record<string, string> }} [options]
 * @returns {{ provider: string, url: string,
 *   headers: Record<string, string>, model: string }}
 */
export function resolveEndpoint(options = {}) {
  const provider = options.provider
    ?? (typeof options.baseUrl === 'string' && options.baseUrl.trim() !== '' ? 'custom' : 'openrouter');
  const preset = PROVIDERS[provider];
  if (preset === undefined)
    throw new AiError('AI0001', `unknown provider '${provider}' (${Object.keys(PROVIDERS).join(', ')})`);

  const configured = (options.baseUrl ?? '').trim();
  const raw = configured === '' ? preset.baseUrl : configured;
  if (raw === null || raw === '')
    throw new AiError('AI0001', `provider '${provider}' needs a baseUrl`);

  const base = normalizeBaseUrl(raw, preset.local);
  /** @type {Record<string, string>} */
  const headers = { 'content-type': 'application/json' };
  const apiKey = (options.apiKey ?? '').trim();
  if (apiKey !== '') headers.authorization = `Bearer ${apiKey}`;
  Object.assign(headers, options.headers);

  return { provider, url: `${base}/chat/completions`, headers, model: options.model ?? '' };
}

/**
 * Forgiving base-URL normalization: trailing slashes and a pasted
 * `/chat/completions` suffix are stripped; local runtimes with a bare
 * origin get their `/v1` prefix.
 * @param {string} raw
 * @param {boolean} local
 * @returns {string}
 */
function normalizeBaseUrl(raw, local) {
  let base = raw.replace(/\/+$/, '');
  if (base.endsWith('/chat/completions'))
    base = base.slice(0, -'/chat/completions'.length);
  /** @type {URL} */
  let url;
  try {
    url = new URL(base);
  }
  catch {
    throw new AiError('AI0001', `invalid baseUrl '${raw}'`);
  }
  if (local && (url.pathname === '' || url.pathname === '/'))
    base = `${base}/v1`;
  return base;
}
