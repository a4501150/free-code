# Provider API Research

Research compiled 2026-04-21. Sources cited inline.

---

## Summary of Key Divergences

These are the dimensions where providers fundamentally diverge in ways that force per-provider logic, not just field renaming:

1. **Conversation shape: messages array vs items array.** Anthropic, Chat Completions, Bedrock Converse all use a `messages[]` array with role/content entries. The OpenAI Responses API uses a flat `input[]` / `output[]` of heterogeneous *items* where tool calls and tool results are first-class items, not content blocks nested inside a message. Translating multi-step tool-call turns between these two shapes is lossy when reasoning items appear between tool calls (o3/o4-mini behavior).

2. **Tool-call correlation ID model is structurally different across four providers.** Anthropic uses `tool_use.id` / `tool_result.tool_use_id` (ID inside content blocks). Chat Completions uses `tool_calls[].id` (array on the assistant message) correlated to a separate `tool` role message with `tool_call_id`. Responses API uses `call_id` on top-level `function_call` / `function_call_output` items. Gemini matches by **name only** (no ID). Bedrock Converse uses `toolUse.toolUseId` / `toolResult.toolUseId` (same pattern as Anthropic but different field names). No mechanical mapping exists between name-only (Gemini) and ID-based systems.

3. **Reasoning/thinking is represented and reinjected differently by every provider.** Anthropic returns signed `thinking` blocks that must be echoed back verbatim; Responses API reasoning items may be opaque/encrypted and are persisted server-side or returned as `encrypted_content` for stateless mode; Gemini returns summarized thought parts with signatures that must not be split or merged. None of these representations can be round-tripped through each other.

4. **Prompt caching: placement vs. automatic vs. separate resource.** Anthropic requires explicit `cache_control` breakpoints in the request; OpenAI caches automatically by prefix (no user control, no markers); Gemini requires creating a separate `cachedContent` resource and referencing it by ID. An adapter can strip Anthropic markers going out to OpenAI, but there is no way to reconstruct breakpoint positions coming back, and the billing metadata fields are disjoint.

5. **System/instructions are passed differently.** Anthropic: top-level `system` field (string or array of text blocks with optional `cache_control`). OpenAI Chat Completions: a message with `role: "system"` inside `messages[]`. OpenAI Responses: a separate top-level `instructions` field. Gemini: a top-level `systemInstruction` field containing a `Content` object. Bedrock Converse: a top-level `system` field as an array of `SystemContentBlock` objects.

6. **Tool schema wrapping differs.** Anthropic uses `input_schema` (JSON Schema). Chat Completions wraps the function under `{"type":"function","function":{"name","description","parameters"}}`. Responses API flattens it to `{"type":"function","name","description","parameters"}`. Gemini uses `functionDeclarations[].parameters` (OpenAPI subset). Bedrock Converse uses `toolSpec.inputSchema.json` (an extra level of wrapping).

7. **Streaming event namespaces are entirely disjoint.** Anthropic: `message_start`, `content_block_start/delta/stop`, `message_delta`, `message_stop`. Chat Completions: `data: {choices:[{delta:{}}]}` chunks with no named events. Responses API: `response.output_text.delta`, `response.function_call_arguments.delta`, `response.reasoning_text.delta`, `response.done`. Gemini: repeated `GenerateContentResponse` SSE objects via `?alt=sse`. Bedrock ConverseStream: typed union events (`messageStart`, `contentBlockDelta`, `messageStop`, `metadata`). Tool-call arguments are streamed as chunked JSON in Anthropic (`input_json_delta`), Chat Completions (`delta.tool_calls[].function.arguments`), and Responses (`response.function_call_arguments.delta`), but Gemini returns function call args as a complete JSON object in one part.

8. **Usage/token accounting field names are entirely different per provider**, with caching fields added orthogonally and no common schema.

9. **Error signaling: some providers surface terminal errors mid-stream; others only pre-stream.** Bedrock has `modelStreamErrorException` and `throttlingException` as typed union members of the stream itself. Anthropic sends an `event: error` SSE mid-stream. OpenAI Responses sends an `error` event. Gemini errors come as HTTP errors before streaming or as `finishReason: SAFETY/RECITATION` inside candidates.

10. **Deployment variants change auth and wire format.** Anthropic on Bedrock moves `anthropic_version` from a header to the request body and changes its value; on Vertex it similarly moves to the body and the model moves to the URL path; auth switches from API key to SigV4 / GCP OAuth2. These variants are not transparent to a generic adapter.

---

## Per-Provider Details

### Anthropic Messages API

**Reference:** https://platform.claude.com/docs/en/api/messages

#### Request Shape

```
POST https://api.anthropic.com/v1/messages
x-api-key: ...
anthropic-version: 2023-06-01
anthropic-beta: <comma-separated beta flags>
```

Top-level envelope:
- `model` (required)
- `messages` (required) — array of `{role: "user"|"assistant", content: string | ContentBlock[]}`
- `max_tokens` (required)
- `system` — string or `[{type:"text", text:"...", cache_control:{...}}]`
- `tools` — array of tool definitions
- `tool_choice` — `{type:"auto"|"any"|"tool", name?:...}`
- `thinking` — `{type:"enabled", budget_tokens: N}`
- `stream` — boolean
- `temperature`, `top_p`, `top_k`, `stop_sequences`, `metadata`

System prompt supports `cache_control` per block when passed as an array, enabling selective cache placement on the system prompt independently from messages.

Tool declaration format:
```json
{
  "name": "get_weather",
  "description": "...",
  "input_schema": { "type": "object", "properties": {...}, "required": [...] },
  "cache_control": { "type": "ephemeral" }
}
```

Built-in server tools (web_search, code_execution, bash, str_replace_editor) use a typed `type` field instead of `input_schema`.

#### Content Block Taxonomy

| Block type | Direction | Key fields |
|---|---|---|
| `text` | both | `text` |
| `image` | user | `source: {type:"base64"|"url", media_type, data|url}` |
| `document` | user | `source: {type:"base64"|"url"|"text"|"content", ...}`, `title`, `citations` |
| `tool_use` | assistant | `id`, `name`, `input` (object) |
| `tool_result` | user | `tool_use_id`, `content` (string or blocks), `is_error` |
| `thinking` | assistant | `thinking` (text), `signature` (encrypted token) |
| `redacted_thinking` | assistant | `data` (opaque encrypted blob) |
| `search_result` | user/assistant | `source`, `title`, `content` |

#### Tool-Call Correlation

`tool_use.id` (e.g. `tolu_01abc`) in the assistant turn must be echoed back as `tool_result.tool_use_id` in the next user turn. IDs are stable per request; parallel tool calls produce multiple `tool_use` blocks each with a distinct ID.

#### Streaming

SSE events in order:
1. `message_start` — envelope with `message.id`, `model`, initial `usage`
2. `content_block_start` — `{index, content_block: {type, ...}}`
3. `ping` — keepalive
4. `content_block_delta` — `{index, delta: {type: "text_delta"|"input_json_delta"|"thinking_delta"|"signature_delta", ...}}`
5. `content_block_stop` — `{index}`
6. `message_delta` — `{delta: {stop_reason, stop_sequence}, usage: {output_tokens}}`
7. `message_stop`
8. `error` — `{type:"error", error:{type, message}}` (can appear mid-stream)

Tool call arguments streamed as chunked JSON via `input_json_delta`. Thinking streamed via `thinking_delta` + `signature_delta`.

#### Usage Fields

```json
"usage": {
  "input_tokens": N,
  "output_tokens": N,
  "cache_creation_input_tokens": N,   // tokens written to cache (1.25x or 2x cost)
  "cache_read_input_tokens": N        // tokens served from cache (0.1x cost)
}
```

Standalone token counting without generation: `POST /v1/messages/count_tokens` (free, rate-limited separately).

#### Prompt Caching

Explicit `cache_control: {type:"ephemeral", ttl:"5m"|"1h"}` placed on individual content blocks, tool definitions, or system prompt blocks. Default TTL changed from 1h to 5m in March 2025. Cache hit rate depends on prompt prefix being byte-identical up to the marked block. Cache breakpoints are processed in document order; longer-TTL breakpoints must precede shorter-TTL ones. Thinking blocks cannot have `cache_control` directly but are cached when adjacent content is cached.

Beta header required: `anthropic-beta: prompt-caching-2024-07-31`.

#### Reasoning/Thinking

Request: `"thinking": {"type": "enabled", "budget_tokens": N}` (minimum 1024). Interleaved thinking (thinking between tool calls): requires `anthropic-beta: interleaved-thinking-2025-05-14`.

Response: `thinking` blocks with `thinking` text and `signature` (cryptographic integrity token). `redacted_thinking` blocks have only an opaque `data` field. Both must be echoed back verbatim in subsequent turns (the API ignores them for context-window billing but uses them for reasoning continuity). Signature values are cross-platform compatible (direct, Bedrock, Vertex).

#### Error Model

```json
{ "type": "error", "error": { "type": "<error_type>", "message": "..." } }
```

Error types: `invalid_request_error`, `authentication_error`, `permission_error`, `not_found_error`, `rate_limit_error`, `api_error`, `overloaded_error`. HTTP 4xx/5xx map to these. Errors can appear as SSE `event: error` mid-stream.

#### Stop Reasons

`end_turn`, `max_tokens`, `stop_sequence`, `tool_use`, `refusal`, `pause_turn`.

#### Versioning

- Required header: `anthropic-version: 2023-06-01` (current stable)
- Beta features: `anthropic-beta: <feature-date>` comma-separated, e.g. `extended-thinking-2025-01-01`, `prompt-caching-2024-07-31`, `interleaved-thinking-2025-05-14`
- No path-based versioning

#### Bedrock and Vertex Variants

On **AWS Bedrock**:
- `anthropic_version: "bedrock-2023-05-31"` moves from header to **request body**
- Auth: AWS SigV4 signing
- Endpoint: `POST https://bedrock-runtime.<region>.amazonaws.com/model/<modelId>/invoke`
- Beta flags: `anthropic_beta` list in the request body (not a header)
- Feature parity lags the direct API

On **Google Vertex AI**:
- `anthropic_version: "vertex-2023-10-16"` in **request body**
- Model moved from body to **URL path**
- Auth: GCP OAuth2 Bearer (Application Default Credentials)
- Batch API not supported
- Beta headers forwarded as HTTP headers but support is inconsistent

---

### OpenAI Chat Completions API

**Reference:** https://platform.openai.com/docs/api-reference/chat/create

#### Request Shape

```
POST https://api.openai.com/v1/chat/completions
Authorization: Bearer <key>
```

Top-level envelope:
- `model` (required)
- `messages` (required) — array of message objects
- `tools` — array of function declarations
- `tool_choice` — `"none"|"auto"|"required"` or `{type:"function",function:{name}}`
- `response_format` — JSON mode / structured outputs
- `stream` — boolean
- `temperature`, `max_tokens`, `top_p`, `stop`, etc.
- `parallel_tool_calls` — boolean (default true)

System prompt: a message with `role: "system"` in the `messages[]` array (no special top-level field).

Tool declaration:
```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "...",
    "parameters": { "type": "object", "properties": {...}, "required": [...] }
  }
}
```

#### Content Block Taxonomy

Messages carry a `role` and `content`. Content is a string or array of typed parts.

| Role | Content types | Notes |
|---|---|---|
| `system` | string or text parts | Instructions; placed first in messages[] |
| `user` | text, image_url | Images via URL or base64 data URL |
| `assistant` | string or content parts + `tool_calls[]` | `tool_calls` is a sibling field, not a content part |
| `tool` | string or array | Result of a tool; correlates via `tool_call_id` |

No native document, thinking, or reasoning content blocks. No `tool_use` block type — tool invocations are surfaced via `choices[0].message.tool_calls[]`.

#### Tool-Call Correlation

```json
// In assistant message:
"tool_calls": [
  { "id": "call_abc123", "type": "function", "function": { "name": "fn", "arguments": "{...}" } }
]

// In subsequent tool message:
{ "role": "tool", "tool_call_id": "call_abc123", "content": "<result>" }
```

Arguments are a **JSON-encoded string**, not a parsed object. Parallel tool calls produce multiple entries in `tool_calls[]`, each with a distinct `id`; each must have a corresponding `tool` role message.

#### Streaming

Chunks are `chat.completion.chunk` objects with a `delta` field instead of `message`:
- Text: `delta.content` increments
- Tool calls: `delta.tool_calls[].function.arguments` increments (chunked JSON string); `delta.tool_calls[].index` identifies which call
- First chunk includes `delta.role`
- Final chunk: `finish_reason` set, `delta: {}`

No typed SSE event names — all chunks arrive as `data: {...}` with no `event:` field.

#### Usage Fields

```json
"usage": {
  "prompt_tokens": N,
  "completion_tokens": N,
  "total_tokens": N,
  "prompt_tokens_details": {
    "cached_tokens": N    // tokens served from automatic prefix cache
  }
}
```

No standalone count-tokens endpoint. No per-request cache control; caching is fully automatic.

#### Prompt Caching

Fully automatic prefix caching for prompts >= 1024 tokens. No `cache_control` markers. Cache prefix matching starts from the first 256 tokens. Cache lifetime: 5–10 min inactivity, max 1h. Extended retention (up to 24h) available. Optional `prompt_cache_key` parameter influences routing for higher hit rates (approx. 15 req/min limit before spillover). Discount: 50% on cached input tokens (vs Anthropic's 90%).

#### Error Model

```json
{ "error": { "type": "...", "code": "...", "message": "...", "param": "..." } }
```

Common types: `invalid_request_error`, `authentication_error`, `rate_limit_error`, `server_error`. HTTP 400/401/429/500. Streaming errors arrive as a final `data: {"error":{...}}` chunk before `data: [DONE]`.

#### Finish Reasons

`stop`, `length`, `tool_calls`, `content_filter`, `function_call` (legacy).

#### Versioning

No `openai-version` header requirement. Some experimental features use `openai-beta` header (e.g. Assistants API v2). API capabilities are surfaced through model IDs and documented release notes.

---

### OpenAI Responses API (Codex / o-series)

**Reference:** https://platform.openai.com/docs/api-reference/responses

#### Request Shape

```
POST https://api.openai.com/v1/responses
Authorization: Bearer <key>
```

Top-level envelope:
- `model` (required)
- `input` — string or array of input items
- `instructions` — top-level system-level field (separate from `input`, analogous to system prompt)
- `tools` — array of tool definitions (flat format)
- `reasoning` — `{effort: "low"|"medium"|"high"|"minimal"|"none"|"xhigh"}`
- `store` — boolean (true = stateful, persists items server-side)
- `previous_response_id` — chain responses for stateful multi-turn
- `include` — e.g. `["reasoning.encrypted_content"]` for ZDR mode
- `stream` — boolean

Tool declaration (flat/internally-tagged):
```json
{ "type": "function", "name": "get_weather", "description": "...", "parameters": {...} }
```

#### Content Block Taxonomy / Item Types

The fundamental unit is an **Item** (not a message). The `input` array and `output` array contain a union of item types:

| Item type | Direction | Key fields |
|---|---|---|
| `message` | both | `role`, `content: [{type:"output_text",text}]` |
| `function_call` | output | `call_id`, `name`, `arguments` (JSON string) |
| `function_call_output` | input | `call_id`, `output` (string) |
| `reasoning` | output | `id`, `encrypted_content` (ZDR mode) or `summary` |

A `message` item can contain `output_text` content parts. There is no `tool_use` content block nested inside a message — tool invocations are separate top-level items. This is the critical structural difference from Chat Completions and Anthropic.

#### Tool-Call Correlation

`function_call` items carry a `call_id`. The corresponding `function_call_output` item echoes the same `call_id`. There is no role-switching; both items co-exist in the flat `input[]` / `output[]` arrays. When using `previous_response_id`, all output items (including reasoning) from the prior response are automatically visible to the next call without being re-sent.

For stateless multi-turn with reasoning (ZDR), reasoning items must be included in the subsequent `input[]` with their `encrypted_content`.

#### Streaming

Semantic named events (not just raw JSON chunks):

| Event | Meaning |
|---|---|
| `response.created` | Response object created |
| `response.output_item.added` | New output item started (message, function_call, reasoning) |
| `response.output_text.delta` | Text delta for a message's output_text part |
| `response.output_text.done` | Text part complete |
| `response.function_call_arguments.delta` | Chunked JSON for function call arguments |
| `response.function_call_arguments.done` | Function call arguments complete |
| `response.reasoning_text.delta` | Reasoning text delta |
| `response.reasoning_text.done` | Reasoning text complete |
| `response.reasoning_summary_text.delta` | Summary delta |
| `response.reasoning_summary_text.done` | Summary complete |
| `response.output_item.done` | Item finalized |
| `response.done` | Entire response complete; `status` field on the response object |
| `error` | Error event |

#### Usage Fields

```json
"usage": {
  "input_tokens": N,
  "output_tokens": N,
  "reasoning_tokens": N   // separate field for reasoning tokens
}
```

#### Prompt Caching

Automatic prefix caching (same mechanism as Chat Completions). Using `previous_response_id` improves cache hit rates (40–80% improvement cited vs. Chat Completions per OpenAI internal tests) because the model context is preserved server-side.

#### Reasoning/Thinking

`reasoning.effort` controls budget: `"low"`, `"medium"`, `"high"` (and model-dependent `"minimal"`, `"xhigh"`). Reasoning tokens are billed as output tokens.

For o3/o4-mini: reasoning items adjacent to function calls are preserved and must be included in subsequent turns for full benefit. In stateful mode (`store:true`), handled automatically via `previous_response_id`. In stateless/ZDR mode, each request must include `"reasoning.encrypted_content"` in `include`; returned reasoning items have an `encrypted_content` property that must be passed back in the next request's `input[]`.

Response status for incomplete generation: `status: "incomplete"`, `incomplete_details.reason: "max_output_tokens"|"content_filter"`.

#### Error Model

Same `{error: {type, code, message, param}}` as Chat Completions. Stream errors: `error` event.

#### Stop Reasons / Status

Response-level `status`: `completed`, `failed`, `cancelled`, `incomplete`. `incomplete_details.reason` gives the specific cause. No per-choice `finish_reason` analogous to Chat Completions.

#### Versioning

No `openai-version` header. Some features use `openai-beta` header. Responses API was released in 2025 and is the forward path; Assistants API is deprecated (sunset August 2026).

---

### Google Gemini `generateContent`

**Reference:** https://ai.google.dev/api/generate-content, https://ai.google.dev/gemini-api/docs/function-calling

#### Request Shape

```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
x-goog-api-key: <key>
```

Streaming:
```
POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse
```

Top-level envelope:
- `contents` (required) — array of `Content` objects
- `systemInstruction` — `Content` object with text parts (top-level, not in `contents[]`)
- `tools` — array of tool objects
- `toolConfig` — mode configuration (`functionCallingConfig`)
- `generationConfig` — generation parameters including `thinkingConfig`
- `safetySettings` — per-category harm thresholds
- `cachedContent` — reference to a pre-created cache resource (`cachedContents/{id}`)

Tool declaration:
```json
{
  "functionDeclarations": [
    {
      "name": "get_weather",
      "description": "...",
      "parameters": { "type": "object", "properties": {...}, "required": [...] }
    }
  ]
}
```

Tools are grouped inside a `Tool` object that contains `functionDeclarations[]` — unlike other providers where tools are a flat array.

#### Content Block Taxonomy

Each `Content` has `role: "user"|"model"` and `parts[]`. Part types:

| Part type | Structure |
|---|---|
| Text | `{"text": "..."}` |
| Inline data (image/audio) | `{"inline_data": {"mime_type": "...", "data": "<base64>"}}` |
| File data | `{"file_data": {"mime_type": "...", "file_uri": "..."}}` |
| `functionCall` | `{"functionCall": {"name": "...", "id": "...", "args": {...}}}` |
| `functionResponse` | `{"functionResponse": {"name": "...", "id": "...", "response": {...}}}` |
| Thought (thinking) | Part with `thought: true` boolean field |

No separate roles for function results — `functionResponse` parts live in a `Content` with `role: "user"`. There is no concept of a `tool` role.

#### Tool-Call Correlation

Primarily by **name**. The model returns a `functionCall` part with `name`; the client returns a `functionResponse` part with the same `name`. As of Gemini 2.5+ with function calling + thinking, an `id` field is also returned on both parts for disambiguation when multiple calls share a name, and signatures are attached that must be preserved verbatim.

**Critical difference:** No stable numeric or UUID-based ID in older models — matching is name-based. This breaks if the same function is called twice in parallel.

#### Streaming

Add `?alt=sse` to the URL. The stream is a sequence of `GenerateContentResponse` objects, each as a complete JSON payload in an SSE `data:` line. No named event types (no `event:` field). There is no `content_block_delta` concept — each chunk is a partial `GenerateContentResponse` containing whatever content has been generated since the last chunk. Tool call arguments arrive as a complete JSON object in a single `functionCall` part, not streamed incrementally.

#### Usage Fields

```json
"usageMetadata": {
  "promptTokenCount": N,
  "candidatesTokenCount": N,
  "cachedContentTokenCount": N,    // tokens from a cachedContent resource
  "thoughtsTokenCount": N          // thinking tokens (billed as output)
}
```

Standalone token counting: `POST /v1beta/models/{model}:countTokens` (free, 3000 RPM limit). Returns `totalTokens`, `totalBillableCharacters`, `promptTokensDetails[].tokenCount`.

#### Prompt Caching

**Explicit resource-based caching.** A `CachedContent` object is created via a separate API call and assigned an ID. The generating request references it via `"cachedContent": "cachedContents/{id}"`. The cache contains: model, system instruction, tools, and initial content to cache. Minimum 2048 tokens to cache. TTL defaults to 1h; configurable via `ttl` (duration string) or `expire_time` (RFC3339). Cache must be explicitly deleted or it auto-expires. Cached tokens discounted 75–90% depending on model. Users are billed for storage time (hourly per million tokens).

Not applicable to automatic/implicit caching — no prefix-based caching is available without creating a resource.

#### Reasoning/Thinking

Configured via `generationConfig.thinkingConfig`:
- Gemini 2.5 models: `{"thinkingBudget": N}` (integer; 0=off, -1=dynamic)
- Gemini 3 models: `{"thinkingLevel": "minimal"|"low"|"medium"|"high"}`

Responses include thought parts (parts with `thought: true`) containing summarized versions of internal reasoning. To get thought parts, set `includeThoughts: true` in `thinkingConfig` (best-effort; not guaranteed). `thoughtsTokenCount` in `usageMetadata` shows thinking token usage (billed as output).

For multi-turn conversations with function calling + thinking (Gemini 2.5+), thought signatures are attached to parts and must be passed back as received — do not split, merge, or filter these parts.

#### Error Model

HTTP errors return:
```json
{ "error": { "code": N, "message": "...", "status": "<gRPC status string>" } }
```

Common gRPC statuses: `INVALID_ARGUMENT` (400), `RESOURCE_EXHAUSTED` (429), `INTERNAL` (500), `UNAVAILABLE` (503), `DEADLINE_EXCEEDED` (504).

Successful responses with generation issues use `finishReason` on the candidate. Mid-stream errors arrive as HTTP errors (stream drops) rather than typed error events.

#### Finish Reasons

`STOP`, `MAX_TOKENS`, `SAFETY`, `RECITATION`, `BLOCKLIST`, `PROHIBITED_CONTENT`, `MALFORMED_FUNCTION_CALL`, `OTHER`. Note: `SAFETY` blocks the entire candidate and returns no content; `safetyRatings` provides category-level detail.

#### API Versioning

Version is in the URL path: `v1beta` (current; `v1` for GA features). No version header required.

#### Vertex AI Variant

Endpoint: `https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{model}:generateContent`

Auth: GCP OAuth2 Bearer. Request body is otherwise identical to the AI Studio API. Same `functionDeclarations` format. Vertex AI offers enterprise SLAs, VPC Service Controls, and data residency controls. Context caching is also available on Vertex under `projects/{project}/locations/{location}/cachedContents`.

---

### AWS Bedrock Converse API

**Reference:** https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html, https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html

#### Request Shape

```
POST https://bedrock-runtime.<region>.amazonaws.com/model/{modelId}/converse
Authorization: AWS Signature Version 4
```

Top-level envelope:
- `messages` (required) — array of `Message` objects
- `system` — array of `SystemContentBlock` objects (`[{"text":"..."}]`)
- `inferenceConfig` — `{maxTokens, temperature, topP, stopSequences}`
- `toolConfig` — `{tools: [Tool], toolChoice: {auto|any|tool}}`
- `additionalModelRequestFields` — passthrough for model-specific params not in the common schema
- `guardrailConfig` — Bedrock Guardrails integration
- `requestMetadata`, `performanceConfig`, `serviceTier`, `outputConfig`

System prompt: array of `SystemContentBlock` (currently only `text` type).

Tool declaration:
```json
{
  "toolSpec": {
    "name": "get_weather",
    "description": "...",
    "inputSchema": { "json": { "type": "object", "properties": {...}, "required": [...] } }
  }
}
```

Note the extra `inputSchema.json` nesting and use of `toolSpec` wrapper. Tool input schema is embedded under a `json` key (to distinguish from future schema types).

#### Content Block Taxonomy

`ContentBlock` is a **union type** — only one field may be set per block:

| Field | Type | Notes |
|---|---|---|
| `text` | string | Plain text |
| `image` | `ImageBlock` | `{format:"jpeg"|"png"|"gif"|"webp", source:{bytes|s3Location}}` |
| `document` | `DocumentBlock` | PDF, Word, etc. — up to 4.5 MB, max 5 per message |
| `video` | `VideoBlock` | Video content |
| `toolUse` | `ToolUseBlock` | `{toolUseId, name, input}` — model requests a tool |
| `toolResult` | `ToolResultBlock` | `{toolUseId, content, status:"success"|"error"}` |
| `reasoning` | `ReasoningBlock` | Chain-of-thought; encrypted on Bedrock for Claude thinking |
| `searchResult` | `SearchResultBlock` | Retrieved search content |

Up to 20 images and 5 documents per message. Images: max 3.75 MB, 8000×8000 px.

#### Tool-Call Correlation

`toolUse.toolUseId` in the assistant message is echoed as `toolResult.toolUseId` in the subsequent user message — same pattern as Anthropic's `tool_use_id` but using camelCase field names. The conversation must be reconstructed manually (no stateful API).

#### Streaming (ConverseStream)

```
POST /model/{modelId}/converse-stream
```

The response is an event-stream union. Events:

| Event key | Structure | Notes |
|---|---|---|
| `messageStart` | `{role}` | Start of assistant turn |
| `contentBlockStart` | `{contentBlockIndex, start}` | Block opening |
| `contentBlockDelta` | `{contentBlockIndex, delta}` | Incremental content |
| `contentBlockStop` | `{contentBlockIndex}` | Block closed |
| `messageStop` | `{stopReason, additionalModelResponseFields}` | Turn complete |
| `metadata` | `{usage, metrics, trace, ...}` | Token counts arrive here, at end of stream |
| `internalServerException` | exception | HTTP 500, mid-stream |
| `modelStreamErrorException` | exception | HTTP 424, mid-stream |
| `throttlingException` | exception | HTTP 429, mid-stream |
| `validationException` | exception | HTTP 400, mid-stream |
| `serviceUnavailableException` | exception | HTTP 503, mid-stream |

Usage is emitted in the `metadata` event at the **end** of the stream (not in the initial response or mid-stream). Error exceptions are typed union members of the stream, not raw HTTP errors — a key difference that enables reliable mid-stream error detection.

#### Usage Fields

```json
"usage": {
  "inputTokens": N,
  "outputTokens": N,
  "totalTokens": N,
  "cacheReadInputTokens": N,
  "cacheWriteInputTokens": N,
  "cacheDetails": [{ "inputTokens": N, "ttl": "5m"|"1h" }]
}
```

#### Prompt Caching

For the Converse API, explicit cache markers use a `cachePoint` object appended to content arrays:
```json
{ "cachePoint": { "type": "default", "ttl": "5m"|"1h" } }
```

For the InvokeModel API (Anthropic wire format), `cache_control` in the Anthropic-native request body is used. Bedrock automatically checks up to ~20 blocks back from the checkpoint for longest-matching prefix (simplifying multi-checkpoint management). Default TTL: 5 min; extended TTL (1h) available for select Claude 4.x models.

#### Error Model

Pre-stream errors: standard HTTP exceptions with AWS error body. Mid-stream errors: typed union members of the event stream (see streaming table above). `ModelStreamErrorException` is unique to Bedrock's streaming model — it surfaces model-side errors that occur after streaming has begun, which would be undetectable from HTTP status alone.

Error types with HTTP codes: `ValidationException` (400), `AccessDeniedException` (403), `ResourceNotFoundException` (404), `ModelTimeoutException` (408), `ModelErrorException` (424), `ThrottlingException` (429), `ModelNotReadyException` (429, auto-retries 5×), `InternalServerException` (500), `ServiceUnavailableException` (503).

#### Stop Reasons

`end_turn`, `tool_use`, `max_tokens`, `stop_sequence`, `guardrail_intervened`, `content_filtered`, `malformed_model_output`, `malformed_tool_use`, `model_context_window_exceeded`.

#### Versioning

No API version header. Model capabilities are gated by model ID. `additionalModelRequestFields` is the escape hatch for model-specific parameters not in the Converse common schema. The Converse API normalizes across all Bedrock models; InvokeModel exposes the native wire format per model.

---

## Dimension Comparison Tables

### Content Block Types

| Block concept | Anthropic | OpenAI Chat Completions | OpenAI Responses | Gemini | Bedrock Converse |
|---|---|---|---|---|---|
| Plain text | `{type:"text"}` | `content` string / `{type:"text"}` | `output_text` in message | `{text:"..."}` part | `{text:"..."}` |
| Image | `{type:"image",source:{type,media_type,data}}` | `{type:"image_url",image_url:{url}}` | (same as Chat) | `{inline_data:{mime_type,data}}` or `file_data` | `{image:{format,source:{bytes}}}` |
| Document/file | `{type:"document",source:{...}}` | Not native | Not native | `file_data` | `{document:{...}}` |
| Tool invocation | `{type:"tool_use",id,name,input}` in assistant | `tool_calls[{id,function.name,function.arguments}]` on assistant message | `function_call` top-level item with `call_id` | `{functionCall:{name,id?,args}}` part | `{toolUse:{toolUseId,name,input}}` |
| Tool result | `{type:"tool_result",tool_use_id,content}` in user | Role `"tool"` message with `tool_call_id` | `function_call_output` item with `call_id` | `{functionResponse:{name,id?,response}}` part in user Content | `{toolResult:{toolUseId,content,status}}` |
| Thinking/reasoning | `{type:"thinking",thinking,signature}` | Not supported | `reasoning` item | Part with `thought:true` | `{reasoning:{...}}` (Claude-specific) |
| Redacted thinking | `{type:"redacted_thinking",data}` | Not supported | Encrypted in reasoning item | Not exposed | Encrypted on Bedrock |

### Tool-Call ID Model

| Provider | ID field | Location | Result correlation | Same-name parallel calls |
|---|---|---|---|---|
| Anthropic | `tool_use.id` (e.g. `toolu_...`) | Inside content block | `tool_result.tool_use_id` | Each gets distinct ID |
| Chat Completions | `tool_calls[].id` (e.g. `call_...`) | Sibling array on assistant message | `tool` role msg `tool_call_id` | Each gets distinct ID in array |
| Responses API | `call_id` on `function_call` item | Top-level item field | `function_call_output.call_id` | Each gets distinct `call_id` |
| Gemini | None (legacy) / `functionCall.id` (Gemini 2.5+ with thinking) | Inside Part | `functionResponse.name` match | Breaks without `id` |
| Bedrock Converse | `toolUse.toolUseId` | Inside content block | `toolResult.toolUseId` | Each gets distinct ID |

### Streaming Event Types

| Phase | Anthropic | Chat Completions | Responses API | Gemini | Bedrock Converse |
|---|---|---|---|---|---|
| Stream open | `message_start` | First chunk | `response.created` | First SSE data | `messageStart` |
| Text delta | `content_block_delta` / `text_delta` | `delta.content` | `response.output_text.delta` | Partial `GenerateContentResponse` | `contentBlockDelta` |
| Tool args delta | `input_json_delta` | `delta.tool_calls[].function.arguments` | `response.function_call_arguments.delta` | No delta (whole args in one part) | `contentBlockDelta` |
| Reasoning delta | `thinking_delta` | Not applicable | `response.reasoning_text.delta` | (no streaming delta) | Not exposed |
| Usage | `message_delta` usage | Final chunk (if `stream_options.include_usage`) | `response.done` object | Not in stream | `metadata` event |
| Stream end | `message_stop` | `data: [DONE]` | `response.done` | Stream closes | `messageStop` |
| Mid-stream error | `event: error` | `data:{error:{...}}` | `error` event | HTTP drop | Typed exception events |

### Usage Fields

| Field concept | Anthropic | Chat Completions | Responses API | Gemini | Bedrock Converse |
|---|---|---|---|---|---|
| Input tokens | `input_tokens` | `prompt_tokens` | `input_tokens` | `promptTokenCount` | `inputTokens` |
| Output tokens | `output_tokens` | `completion_tokens` | `output_tokens` | `candidatesTokenCount` | `outputTokens` |
| Cache write tokens | `cache_creation_input_tokens` | (none) | (none) | (none — separate billing) | `cacheWriteInputTokens` |
| Cache read tokens | `cache_read_input_tokens` | `prompt_tokens_details.cached_tokens` | (same as Chat) | `cachedContentTokenCount` | `cacheReadInputTokens` |
| Reasoning tokens | (in `output_tokens`) | Not applicable | `reasoning_tokens` (separate) | `thoughtsTokenCount` | (in output, model-specific) |
| Count without generating | `/v1/messages/count_tokens` | No endpoint | No endpoint | `/{model}:countTokens` | `bedrock-runtime:count_tokens` |

### Cache Model

| Dimension | Anthropic | OpenAI (Chat + Responses) | Gemini | Bedrock Converse |
|---|---|---|---|---|
| User control | Explicit `cache_control` breakpoints | None (fully automatic) | Explicit `cachedContent` resource | Explicit `cachePoint` or `cache_control` |
| Placement | Per-block markers in request | Automatic prefix matching (first 1024+ tokens) | Entire pre-created `cachedContent` object | CachePoint appended to content arrays |
| Default TTL | 5 min (was 1h pre-March 2025) | 5–10 min inactivity / max 1h | 1 hour (configurable) | 5 min default; 1h for select models |
| Discount on cache read | 90% (0.1x) | 50% | 75–90% | Varies by model |
| Cache write cost | 1.25x (5 min) or 2x (1h) | No write cost | Standard input rate | Varies |
| Minimum tokens | 1024 | 1024 | 2048 | 1024 |
| Storage billing | No | No | Yes (hourly per M tokens) | No |
| Placement constraints | Longer TTL before shorter TTL | None | N/A (separate resource) | Longer TTL before shorter TTL |

### Reasoning Model

| Dimension | Anthropic | OpenAI Responses | Gemini |
|---|---|---|---|
| Budget control | `thinking.budget_tokens` (integer) | `reasoning.effort` (enum) | `thinkingBudget` (integer) or `thinkingLevel` (enum, Gemini 3 only) |
| Reasoning visible | Yes — `thinking` blocks with text | Partial — `reasoning_summary` only; raw thinking encrypted | Yes — thought parts with summarized text (best-effort) |
| Reinject across turns | Must echo `thinking` + `redacted_thinking` blocks verbatim | Automatic via `previous_response_id`; manual via `encrypted_content` in ZDR mode | Must pass thought parts with signatures verbatim; no merging |
| Integrity token | `signature` field on thinking block | `encrypted_content` on reasoning item | Signature on individual parts |
| Billed as | Output tokens | Output tokens (separate `reasoning_tokens` field) | Output tokens (`thoughtsTokenCount`) |

### Error and Finish-Reason Model

| Dimension | Anthropic | Chat Completions | Responses API | Gemini | Bedrock Converse |
|---|---|---|---|---|---|
| Error body | `{type:"error",error:{type,message}}` | `{error:{type,code,message,param}}` | Same as Chat | `{error:{code,status,message}}` | AWS exception shape |
| Rate limit error | `rate_limit_error` | `rate_limit_error` | same | `RESOURCE_EXHAUSTED` (429) | `ThrottlingException` (429) |
| Context window exceeded | `invalid_request_error` + message | `context_length_exceeded` code | `incomplete_details.reason` | `INVALID_ARGUMENT` | `model_context_window_exceeded` stop reason |
| Mid-stream errors | SSE `event: error` | `data:{error:{...}}` chunk | `error` event | HTTP stream drop | Typed union events in stream |
| Safety block | `refusal` stop reason | `content_filter` finish reason | `incomplete` status | `SAFETY` / `PROHIBITED_CONTENT` finishReason | `content_filtered` stop reason |
| Natural end | `end_turn` | `stop` | `status: "completed"` | `STOP` | `end_turn` |
| Token limit | `max_tokens` | `length` | `incomplete` + `max_output_tokens` reason | `MAX_TOKENS` | `max_tokens` |
| Tool call requested | `tool_use` | `tool_calls` | N/A (items model) | `MALFORMED_FUNCTION_CALL` (error case) | `tool_use` |
| Malformed function call | (validation error) | (not named) | (not named) | `MALFORMED_FUNCTION_CALL` | `malformed_tool_use` |

---

## Implications for Abstraction Design

### Dimensions where Anthropic shape as internal representation works with adapters

**Tool schema translation is mechanical.** The schema content is JSON Schema in all five cases. The wrapping differs (Anthropic's `input_schema`, Chat Completions' `function.parameters`, Responses' flat `parameters`, Gemini's `parameters` inside `functionDeclarations`, Bedrock's `inputSchema.json`), but automated re-wrapping is lossless.

**System prompt translation is mechanical.** Anthropic's `system: string` → Chat Completions `messages[0]:{role:"system"}` → Responses `instructions` → Gemini `systemInstruction.parts[0].text` → Bedrock Converse `system:[{text}]`. An adapter can do this without loss (excluding cache control markup on the system prompt, which is provider-specific and must be stripped).

**Stop reason / status normalization is feasible** with a lookup table. The semantic categories (natural end, token limit, tool call, safety block, context exceeded) appear in all five providers; names differ but meanings align well enough to normalize.

**Basic usage normalization is feasible** (input/output counts), with the caveat that some providers bundle reasoning tokens inside output while Responses API separates them.

**Streaming text deltas can be normalized.** All providers stream incremental text in some form. An adapter can subscribe to provider-specific events and emit a canonical `{type:"text_delta",text}` event.

### Dimensions where Anthropic shape forces per-provider logic or is lossy

**Tool-call turn reconstruction for Gemini without IDs.** Anthropic's internal representation uses `tool_use_id` as the correlation anchor. Translating to Gemini requires dropping the ID and matching by name. If a turn calls the same function twice, the round-trip is ambiguous. An adapter going Anthropic → Gemini must enforce unique-name-per-turn or accept the ambiguity. Going Gemini → Anthropic, synthetic IDs must be generated. This is not lossless.

**Responses API item structure cannot be directly expressed in Anthropic's message+content model.** A Responses API turn with `[message, function_call, reasoning, function_call_output]` as top-level peers is structurally incompatible with Anthropic's model where tool invocations are content blocks nested inside a message. Translating Responses → Anthropic shape requires splitting and re-nesting; translating Anthropic → Responses requires un-nesting and re-typing. For turns interleaving reasoning and multiple tool calls (o3/o4-mini behavior), the reconstruction is lossy because reasoning items in Responses API carry `encrypted_content` that has no equivalent in Anthropic's shape.

**Prompt caching `cache_control` markers have no Gemini or OpenAI equivalent.** An adapter going Anthropic → OpenAI/Responses can strip `cache_control` (OpenAI caches automatically), but there is no signal coming back to know which tokens were cache-created vs cache-read — the billing fields differ (`cache_creation_input_tokens` vs `prompt_tokens_details.cached_tokens`). More critically, Gemini's resource-based caching requires a separate out-of-band API call to create a `cachedContent` resource; no Anthropic-shaped request can transparently trigger this. Cache control placement on Anthropic content blocks has no equivalent concept in Gemini.

**Reasoning block reinsertion is provider-specific and opaque.** Anthropic's signed `thinking` blocks must be echoed back unchanged; their wire shape is Anthropic-proprietary. Responses API's `encrypted_content` on reasoning items is OpenAI-proprietary and encrypted differently. Gemini's signed thought parts use a third format. None of these can be translated to another provider's format — they are opaque provider-encrypted blobs. An Anthropic-shape abstraction that stores thinking blocks verbatim for re-injection will only work when sending back to Anthropic; the same blobs cannot be re-submitted to OpenAI or Gemini. A provider-agnostic multi-turn conversation that involves thinking therefore requires either (a) dropping thinking between turns (losing reasoning continuity) or (b) storing provider-native reasoning blobs tagged by provider, which is a richer internal representation than Anthropic's shape alone.

**Streaming event taxonomy is fully disjoint.** An adapter emitting Anthropic streaming events when the underlying provider is OpenAI Responses must consume `response.function_call_arguments.delta` (named, semantically typed) and re-emit `input_json_delta` (Anthropic convention). This is mechanical but requires a complete per-provider stream parser; there is no common substrate.

**Bedrock mid-stream errors are typed union members; others are not.** `ModelStreamErrorException` and `ThrottlingException` appearing as typed stream events require provider-specific stream parsing — they are not surfaced as HTTP errors and cannot be caught with generic HTTP error handling.

**Auth and deployment variants require per-provider logic regardless of wire shape.** SigV4 signing (Bedrock), GCP OAuth2 + model-in-URL (Vertex), API key (Anthropic direct, OpenAI, Gemini AI Studio) are orthogonal to the request body schema. Any abstraction must accommodate per-provider auth even if the body format were identical.

**Conclusion:** Anthropic's Messages shape is a reasonable *default* internal representation for an Anthropic-first CLI — it covers the common case (text, tools, images) with low adapter overhead for Bedrock and Vertex (same wire format, different auth/wrapping). For OpenAI Chat Completions the adapter overhead is modest (role-based tool messages vs content blocks, `tool_calls` array vs `tool_use` block). For Gemini the adapter is heavier (name-based correlation, different streaming shape, resource-based caching). For OpenAI Responses the adapter is structurally lossy for multi-turn reasoning-interleaved tool use. A truly provider-agnostic abstraction that avoids loss would need to represent: (1) tool call correlation as a first-class ID that can be provider-native or synthetic, (2) reasoning blobs as tagged opaque provider-specific payloads, (3) caching intent separately from caching implementation (stripped vs. breakpointed vs. resource ID). Whether the overhead of that richer abstraction is justified depends on whether OpenAI Responses and Gemini are first-class citizens or secondary targets.

---

## Sources

- Anthropic Messages API: https://platform.claude.com/docs/en/api/messages
- Anthropic prompt caching: https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- Anthropic extended thinking: https://platform.claude.com/docs/en/build-with-claude/extended-thinking
- Anthropic token counting: https://docs.anthropic.com/en/api/messages-count-tokens
- OpenAI Chat Completions reference: https://platform.openai.com/docs/api-reference/chat/create
- OpenAI prompt caching: https://platform.openai.com/docs/guides/prompt-caching
- OpenAI Responses API reference: https://platform.openai.com/docs/api-reference/responses
- OpenAI Responses API streaming events: https://platform.openai.com/docs/api-reference/responses-streaming
- OpenAI migration guide (Chat → Responses): https://developers.openai.com/api/docs/guides/migrate-to-responses
- OpenAI reasoning guide: https://developers.openai.com/api/docs/guides/reasoning
- OpenAI reasoning cookbook: https://cookbook.openai.com/examples/responses_api/reasoning_items
- Google Gemini generateContent reference: https://ai.google.dev/api/generate-content
- Google Gemini function calling: https://ai.google.dev/gemini-api/docs/function-calling
- Google Gemini thinking: https://ai.google.dev/gemini-api/docs/thinking
- Google Gemini context caching: https://ai.google.dev/gemini-api/docs/caching
- Google Gemini token counting: https://ai.google.dev/api/tokens
- Google Vertex AI inference reference: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference
- Google Vertex AI context caching: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/context-cache/context-cache-overview
- AWS Bedrock Converse reference: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Converse.html
- AWS Bedrock ConverseStream reference: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ConverseStream.html
- AWS Bedrock prompt caching: https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html
- AWS Bedrock ContentBlock reference: https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_ContentBlock.html
