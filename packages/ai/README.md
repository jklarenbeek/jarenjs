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

**Retries are built in.** Transient failures — network errors, 408, 429, 5xx — back off
exponentially with full jitter and try again (`retry: { attempts, baseMs, maxMs }`,
default 3 total tries; `attempts: 1` disables). A provider `Retry-After` header (seconds
or HTTP-date) overrides the computed delay, capped at `maxMs`. Two hard rules: a request
never retries once the caller has observed a streamed delta, and an abort cancels the
backoff immediately. The final `AI0002` reports what happened: `status`, `attempts`,
`retryAfterMs`.

**Reasoning models are first-class.** Thinking streamed as `delta.reasoning` (or
`reasoning_details`) reaches the caller through `onReasoning`, and the final message
carries a `reasoning` member — so a reasoning-only turn (empty `content`, non-empty
`reasoning`) is distinguishable from an empty one instead of rendering as a blank bubble.
The agent attaches `reasoning` to the **returned** message only: the transcript it
accumulates never carries it, so a host that persists `messages` and sends them back next
turn keeps a clean wire history.

**Probe before the first turn.** `probeProvider({ provider, baseUrl, apiKey })` GETs the
provider's `/models` listing with exactly the auth a chat call would use and never throws:
`{ ok: true, models }` or `{ ok: false, status?, error }` — the contract a settings UI
wants for a "Test connection" button and a model picker.

## Structured output

```js
import { createStructuredOutput } from '@jarenjs/ai';
import schema from '@jarenjs/json/schemas/jaren-query.llm-profile.schema.json' with { type: 'json' };

const out = createStructuredOutput({ client, schema, name: 'jaren_query' });
const result = await out.generate([{ role: 'user', content: 'books over €10' }]);
if ('value' in result) compileJsonQuery(result.value);   // validated, ready to compile
else console.log(result.errors);                          // instancePath'd, model-readable
```

One call, every provider tier: where the provider speaks
`response_format: json_schema` the schema constrains decoding; where it only has JSON
mode, or nothing, the schema travels in a system instruction. Either way the reply is
parsed (accidental code fences stripped) and **validated locally** by `@jarenjs/validate`
— the provider is an accelerator, never the authority — and a failed round goes back to
the model with the instancePath'd errors for a bounded number of repairs (`maxRepairs`,
default 1). The query/JSLT grammars ship LLM-profile twins built for exactly this
(see `@jarenjs/json`'s README).

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

Weak models routinely JSON-*encode* a nested argument. Where the schema wants an object or
an array and a parseable JSON string arrived, the toolbox parses it and validates the
parsed value, so the tool sees what the model meant instead of a type error. A rejected
call answers `{ error, errors, inputSchema }` — up to eight validation errors as
`{ instancePath, keyword, message }`, plus the tool's own schema to re-read — and adds a
named `hint` when a property that wanted structure arrived as JSON text that does not
parse, naming the offending properties.

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

**Long sessions fit small contexts.** `historyBudget` (characters — deterministic where
tokens are provider-private) compacts each request when the history outgrows it: the
system prompt, the first user message and the largest tail that fits always survive, and
the dropped middle becomes one synopsis message naming every dropped tool round. Cuts
happen only at tool-round boundaries, so `tool_calls`/`tool` pairing stays wire-legal —
always. The built-in synopsis is pure string work (no second model call; a single local
model runs unassisted); `compaction: (droppedRounds) => string` swaps in your own writer.
The returned transcript is always the full, uncompacted history.

## House rules

Like every jarenjs package: ESM, zero runtime dependencies outside `@jarenjs/*`, no
`eval`/`new Function` (CSP-safe), environment injected at the edges. The jarenjs website's
assistant and its WebMCP tools run on exactly this package — the playground engines are
the toolbox, and Jaren validates the model's own tool calls.
