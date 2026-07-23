# @jarenjs/ai

Browser-side AI that actually makes sense. No server, no proxy, no SDK tower: the user
brings their own key (OpenRouter) or their own local runtime URL (Ollama, LM Studio), and
one small client speaks the OpenAI-compatible `/chat/completions` wire format all three
share. Tools are declared with JSON Schema and validated by Jaren itself before they run —
the suite guarding its own tools — and a bounded agent loop keeps even weak local models
on the rails.

```
┌────────────────────────────────────────────────────────────┐
│ createAgent  — bounded tool loop, transcript in/out        │
│   ├── createChatClient — one client: OpenRouter/Ollama/    │
│   │     LM Studio/any OpenAI-compatible URL (fetch is      │
│   │     injected, streaming via createSseDecoder)          │
│   └── createToolbox    — JSON-Schema tools, Jaren-checked  │
│         └── registerModelContext — the same tools over     │
│               WebMCP (navigator.modelContext)              │
└────────────────────────────────────────────────────────────┘
```

## Why browser-side?

Most "AI in the app" designs put a server between the page and the model, because the
server owns the API key. When the key is the *user's own* — a personal OpenRouter key, or
`http://localhost:11434` where their Ollama runs — the server adds nothing but latency and
a place for the key to leak. The key stays in the page, requests go straight to the
provider, and a static site can ship a full assistant.

## The client

```js
import { createChatClient } from '@jarenjs/ai';

const client = createChatClient({
  provider: 'openrouter',            // 'openrouter' | 'ollama' | 'lmstudio' | 'custom'
  apiKey: userKey,                   // omit for local runtimes
  model: 'qwen/qwen3-4b',
});

const { message } = await client.complete({
  messages: [{ role: 'user', content: 'Say hi.' }],
  onDelta: (text) => process.stdout.write(text),   // streamed by default
});
```

Base URLs are forgiving: `http://localhost:11434` becomes `http://localhost:11434/v1`, a
pasted `…/chat/completions` suffix is stripped. `fetch` is injectable
(`createChatClient({ fetch: myFetch })`) so the client runs identically in the browser, in
Node, and in tests against a scripted stub. Failures carry stable codes: `AI0001` (caller
error), `AI0002` (HTTP error status), `AI0003` (malformed payload).

## The toolbox

```js
import { createToolbox, registerModelContext } from '@jarenjs/ai';

const toolbox = createToolbox();
toolbox.add({
  name: 'lookup_order',
  description: 'Look up one order by id.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', minLength: 1 } },
    required: ['id'],
  },
  execute: ({ id }) => orders.get(id) ?? { error: `no order '${id}'` },
});

// the same tools, published to a browser-hosted agent (WebMCP):
registerModelContext(toolbox);
```

Every call is validated against the tool's schema by `@jarenjs/validate` before the tool
runs. `execute` never throws for content-level problems — unknown tool, invalid input, or
a throwing tool all come back as `{ error }` results the model can read and correct.

## The agent loop

```js
import { createAgent } from '@jarenjs/ai';

const agent = createAgent({ client, toolbox, system: 'You are…', maxToolRounds: 5 });
const { message, messages, steps } = await agent.send(history, {
  onDelta: (text) => ui.stream(text),
  onToolCall: ({ name }) => ui.activity(name),
});
```

The loop is bounded (`maxToolRounds`, default 5) and stops with a readable message instead
of spinning; oversized tool results are truncated (`maxToolResultChars`, default 8000) so
a local model's context is respected. `send` never mutates the history it receives — it
returns the complete new transcript, ready to persist and send back next turn.

## House rules

Like every jarenjs package: ESM, zero runtime dependencies outside `@jarenjs/*`, no
`eval`/`new Function` (CSP-safe), environment injected at the edges. The jarenjs website's
assistant and its WebMCP tools run on exactly this package — the playground engines are
the toolbox, and Jaren validates the model's own tool calls.
