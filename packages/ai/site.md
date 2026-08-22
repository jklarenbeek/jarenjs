---
package: "@jarenjs/ai"
card:
  title: AI assistant
  blurb: >-
    Browser-side AI with bring-your-own-key: one OpenAI-compatible client
    (OpenRouter / Ollama / LM Studio), an incremental SSE decoder, retry
    with Retry-After, structured output with local-validation repair,
    token-budget compaction, a bounded agent loop and WebMCP registration.
  perf: >-
    tool calls validated by Jaren before they run
engines:
  - key: ai
    title: AI
---

`@jarenjs/ai` is browser-side AI that makes sense: one OpenAI-compatible chat
client for OpenRouter, Ollama or LM Studio, bring-your-own-key, no server and
no proxy. The site assistant (the ✦ button, bottom-right) runs on it — describe
what you want and it drives the site for you.

Tools are the point. Each Play engine is a tool declared with a JSON Schema,
and Jaren validates the model’s own tool calls before they run — the suite
guarding its own tools. A bounded agent loop keeps even small local models on
the rails: malformed arguments and failing tools come back as readable results
the model can correct, never crashes.

```js
import { createChatClient, createToolbox, createAgent } from '@jarenjs/ai';

const client = createChatClient({ provider: 'ollama', model: 'qwen3:4b' });
const toolbox = createToolbox();
toolbox.add({
  name: 'lookup', description: 'Look up one record.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  execute: ({ id }) => records.get(id) ?? { error: `no '${id}'` },
});
const agent = createAgent({ client, toolbox, maxToolRounds: 5 });
const { message } = await agent.send(history, { onDelta: (t) => ui.stream(t) });
```

The same tools publish over WebMCP (`navigator.modelContext`) with one call, so
a browser-hosted agent drives the identical schema-guarded surface. The
assistant knows the site’s own example library, can save what you build
together as named experiments, and keeps the conversation across reloads.
Everything — the key and the transcript — stays in your browser, stored locally
and sent only to the provider you choose.

A long session used to lose what it found. A history budget keeps the
conversation inside a small local context window, and the middle of it is
replaced by a summary — which remembered that a tool was called and lost what
it returned. The ledger fixes the destruction, not the summarising: every round
that leaves the request is first archived to an addressed slot, the summary
carries the address, and a recall tool fetches the whole round back. The panel
says how many rounds are archived, because a compacted session should look
recoverable rather than silently lossy.

Set an objective in the panel and it outlives the tab: it is stored, composed
into the prompt of every turn together with the progress recorded against it,
and read back from storage on the next visit — so a reloaded page continues
instead of starting over. “Remember this session” asks the model what it
learned, as an RFC 6902 patch over its own memories, and every stage of the
gate runs before anything lands: the patch schema, the suite’s own patch engine
applied to a copy, then the ledger’s schemas. A memory without evidence is
refused, and the assistant’s base instructions are not a patch target at all.

> **Try it** — Open the assistant (bottom-right), add your provider, model and
> — for OpenRouter — an API key in settings, then ask it to validate a schema
> or run any engine. Local runtimes need CORS enabled for this origin (Ollama:
> `OLLAMA_ORIGINS`; LM Studio: the server CORS toggle). [Open Play](#/play)
