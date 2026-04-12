# Provider-Based Model System Refactor

## Context

The current model system is messy: hardcoded env vars (`CLAUDE_CODE_USE_BEDROCK`, etc.) select a single global provider, `ALL_MODEL_CONFIGS` maps model keys to per-provider ID strings, `modelOptions.ts` (550 lines) hand-codes tier/provider permutations, and `getAPIProvider()` is called from ~30 files with ~80 call sites. Adding a new provider or model requires touching 5+ files.

**Goal**: Replace entirely with a config-driven `providers` system in `settings.json`. Each provider type has its own transform (wire format adapter). Legacy env vars are auto-migrated at startup. Drop the Anthropic cloud SDKs (`@anthropic-ai/bedrock-sdk`, `@anthropic-ai/vertex-sdk`, `@anthropic-ai/foundry-sdk`) — we build our own transforms using native cloud SDKs for auth only.

## Reference Materials

- **llms repo** (local): `/Users/jinyangli/src/llms` — universal LLM API transformation proxy. Use extensively as reference for transform architecture, provider config format, and streaming SSE translation. Key files:
  - `src/transformer/anthropic.transformer.ts` — Anthropic Messages API ↔ unified (OpenAI Chat Completions) format. ~1069 lines. Handles bidirectional streaming SSE conversion, tool use, thinking blocks.
  - `src/transformer/openai.transformer.ts` — OpenAI Chat Completions passthrough (7 lines — the unified format IS Chat Completions)
  - `src/transformer/openai.responses.transformer.ts` — OpenAI Responses API transform
  - `src/transformer/gemini.transformer.ts` — Gemini generateContent API transform
  - `src/transformer/vertex-claude.transformer.ts` + `src/utils/vertex-claude.util.ts` — Vertex AI Claude transform with GCP auth (uses `google-auth-library`, NOT `@anthropic-ai/vertex-sdk`)
  - `src/services/provider.ts` — provider registry, model routing
  - `src/services/config.ts` — JSON5 config loading
  - `src/types/llm.ts` — unified types (messages, tools, streaming chunks)
  - `src/types/transformer.ts` — transformer interface
  - `src/utils/converter.ts` — tool format converters between Anthropic/OpenAI/Gemini

- **opencode prompt caching PR**: https://github.com/anomalyco/opencode/pull/5422 — per-provider cache config with three paradigms (explicit breakpoint, automatic prefix, implicit/content-based). 73% cost reduction demonstrated. Reference for cache config schema and provider-specific caching strategy.

- **llms repo caching**: The llms repo handles caching by preserving `cache_control` through the Anthropic transformer and providing a `cleancache` middleware transformer that strips it for providers that don't support it (OpenRouter, Vercel, Groq). The Responses API transformer strips `cache_control` since OpenAI uses automatic prefix caching.

---

## Target Config Format

```json
{
  "providers": {
    "anthropic": {
      "type": "anthropic",
      "baseUrl": "https://api.anthropic.com",
      "cache": { "type": "explicit-breakpoint" },
      "auth": {
        "active": "apiKey",
        "apiKey": { "key": "sk-ant-..." },
        "oauth": { "accessToken": "...", "refreshToken": "...", "expiresAt": 1234567890 }
      },
      "models": [
        { "id": "claude-opus-4-6", "alias": "opus", "label": "Opus 4.6", "description": "Most capable", "context": "1m" },
        { "id": "claude-sonnet-4-6", "alias": "sonnet", "label": "Sonnet 4.6" },
        { "id": "claude-haiku-4-5", "alias": "haiku", "label": "Haiku 4.5" }
      ]
    },
    "my-openai-proxy": {
      "type": "openai-responses",
      "baseUrl": "http://192.168.216.36:3030/openai",
      "cache": { "type": "automatic-prefix" },
      "auth": {
        "active": "apiKey",
        "apiKey": { "key": "mytoken123" }
      },
      "models": [
        { "id": "gpt-5.4", "label": "GPT-5.4" }
      ]
    },
    "deepseek": {
      "type": "openai-chat-completions",
      "baseUrl": "https://api.deepseek.com/v1",
      "cache": { "type": "automatic-prefix" },
      "auth": {
        "active": "apiKey",
        "apiKey": { "keyEnv": "DEEPSEEK_API_KEY" }
      },
      "models": [
        { "id": "deepseek-chat", "label": "DeepSeek V3" }
      ]
    },
    "my-bedrock": {
      "type": "bedrock-converse",
      "cache": { "type": "none" },
      "auth": {
        "active": "aws",
        "aws": { "region": "us-east-1" }
      },
      "models": [
        { "id": "anthropic.claude-3-5-sonnet-20240620-v1:0", "alias": "sonnet", "label": "Claude Sonnet (Bedrock)" }
      ]
    },
    "vertex-via-proxy": {
      "type": "vertex",
      "baseUrl": "https://my-vertex-proxy.example.com",
      "cache": { "type": "explicit-breakpoint" },
      "auth": {
        "active": "bearer",
        "bearer": { "token": "my-proxy-token" }
      },
      "models": [
        { "id": "claude-opus-4-6", "label": "Opus 4.6 (Vertex Proxy)" }
      ]
    }
  }
}
```

### Provider `type` (wire format + transform)

The `type` field determines ONLY the wire format and transform logic — NOT the auth method. Auth is configured independently.

| Type | Wire format | Transform reference (llms repo) |
|------|------------|------|
| `anthropic` | Anthropic Messages API | N/A (passthrough — native format) |
| `openai-chat-completions` | OpenAI Chat Completions | `anthropic.transformer.ts` (bidirectional) |
| `openai-responses` | OpenAI Responses API | `openai.responses.transformer.ts` |
| `bedrock-converse` | AWS Bedrock Converse API | N/A (new, reference AWS docs) |
| `vertex` | Vertex AI REST API | `vertex-claude.transformer.ts` |
| `foundry` | Azure Foundry API | N/A (new, reference Azure docs) |
| `gemini` | Gemini generateContent | `gemini.transformer.ts` |

### Auth types (independent of provider type, coexist, user picks `active`)

Auth is **orthogonal** to provider type. Any auth method can be paired with any provider type. For example:
- `type: "vertex"` + `auth.active: "bearer"` — custom Vertex proxy with simple bearer auth
- `type: "vertex"` + `auth.active: "gcp"` — real GCP Vertex with native GCP OAuth
- `type: "openai-chat-completions"` + `auth.active: "aws"` — Bedrock OpenAI-compatible endpoint with SigV4

| Auth method | Config | Implementation |
|---|---|---|
| `apiKey` | `{ key: "literal" }` or `{ keyEnv: "ENV_VAR_NAME" }` | `x-api-key` or `Authorization: Bearer` header |
| `bearer` | `{ token: "..." }` or `{ tokenEnv: "ENV_VAR_NAME" }` | `Authorization: Bearer` header |
| `oauth` | `{ accessToken, refreshToken, expiresAt }` | Managed by `/login <provider>`, auto-refresh |
| `gcp` | `{ projectId?, region? }` | GCP ADC via `google-auth-library`, injects OAuth2 bearer token |
| `aws` | `{ region?, profile? }` | AWS credential chain + SigV4 signing via `@aws-sdk/credential-providers` |
| `azure` | `{ tenantId?, clientId? }` | Azure AD via `@azure/identity`, injects bearer token |

Provider-specific fields like `region`, `projectId` live in the auth config (since they're auth/routing concerns), not at the top level of the provider config.

### Caching types (per-provider)

Reference: [opencode PR #5422](https://github.com/anomalyco/opencode/pull/5422)

| Type | Config value | Behavior | Providers |
|------|-------------|----------|-----------|
| Explicit breakpoint | `explicit-breakpoint` | Keep `cache_control` markers on messages | Anthropic direct, Vertex-Claude |
| Automatic prefix | `automatic-prefix` | Strip `cache_control`; provider caches automatically | OpenAI, DeepSeek, Azure |
| None | `none` | Strip `cache_control`; no caching | Local models, Groq, Bedrock (varies) |

---

## Phase 1: Core Infrastructure + Anthropic/OpenAI Transforms

Ships value immediately for direct API, proxy, and OpenAI-compatible provider users.

### 1.1 Provider config schema

**File**: `src/utils/settings/types.ts` (after line ~398, near `modelOverrides`)

### 1.2 Provider registry

**New file**: `src/utils/model/providerRegistry.ts`

Single source of truth for all provider/model resolution.

### 1.3 Legacy env var auto-migration

**New file**: `src/utils/model/legacyProviderMigration.ts`

Runs at startup when `settings.providers` is absent. Generates provider configs from legacy env vars.

### 1.4 Transform adapters

**New file**: `src/services/api/openai-chat-completions-adapter.ts`

Anthropic Messages API ↔ OpenAI Chat Completions.

### 1.5 Client creation via provider registry

**File**: `src/services/api/client.ts`

Replace the 5-way if/else chain with unified registry dispatch.

### 1.6 Delete dead code

- **Delete**: `src/utils/codex-fetch-adapter.ts` — dead, never imported

---

## Phase 2: Model System Cleanup + Full `getAPIProvider()` Removal

### 2.1-2.8 Simplify model resolution, strings, options, validation, configs, costs

Remove `getAPIProvider()` from ~30 consumer files. Make `getAPIProvider()` and `isFirstPartyAnthropicBaseUrl()` use the provider registry internally.

---

## Phase 3: Per-Provider Caching

Integrate caching type into prompt pipeline. Strip `cache_control` in adapters.

---

## Phase 4: Bedrock Transform (native, no Anthropic SDK)

### 4.1 Bedrock transform adapter

**New file**: `src/services/api/bedrock-adapter.ts`

Native SigV4 signing + AWS EventStream binary parsing.

---

## Phase 5: Vertex + Foundry Transforms

### 5.1 Vertex transform adapter

**New file**: `src/services/api/vertex-adapter.ts`

### 5.2 Foundry transform adapter

**New file**: `src/services/api/foundry-adapter.ts`

---

## Phase 6: Auth — /login and /logout Per-Provider

Multi-provider login with provider auth info panel.

---

## Phase 7: E2E Tests

### 7.1 Mock OpenAI server

**New file**: `tests/helpers/mock-openai-server.ts`

### 7.2 Provider config E2E tests

**New file**: `tests/e2e/provider-config.test.ts`

---

## Implementation Status

All 7 phases implemented. Key design decisions made during implementation:

1. **Auth is config-driven only** — no runtime `isClaudeAISubscriber()` checks in dispatch
2. **Unified dispatch** — ALL provider types go through `createClientForProvider`, no legacy fallthrough
3. **Fail-fast** — throws Error when registry is empty instead of silent fallback
4. **Legacy migration detects OAuth** — passes tokens from secure storage at migration time
5. **`getAPIProvider()` bridge** — existing 33 consumer files use the registry via backward-compatible bridge

## Remaining Work

- Gemini adapter (stub returns null)
- `/login` OAuth flow for non-Anthropic providers (currently shows auth info panel)
- Further cleanup of `isUsing3PServices()` in auth.ts (still reads raw env vars)
