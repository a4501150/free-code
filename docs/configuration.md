# Configuration

## Where the files live

The global configuration directory is `~/.freecode`. `FREECODE_CONFIG_DIR`
overrides it, and `CLAUDE_CONFIG_DIR` is accepted as a fallback. See
[src/utils/envUtils.ts](../src/utils/envUtils.ts).

| File                             | Owns                                |
| -------------------------------- | ----------------------------------- |
| `~/.freecode/freecode.json`      | General application settings        |
| `~/.freecode/modelSettings.json` | Providers, models and model routing |

The split is deliberate. Put a provider in `modelSettings.json`. Put everything
else in `freecode.json`.

`modelSettings.json` owns exactly these keys, listed in
[src/utils/settings/modelSettingsKeys.ts](../src/utils/settings/modelSettingsKeys.ts):

`providers`, `defaultModel`, `defaultSubagentModel`, `defaultSmallFastModel`,
`defaultBalancedModel`, `defaultMostPowerfulModel`, `availableSubagentModels`,
`modelOverrides`, `planModeModel`, `advisorModel`, `teammateDefaultModel`,
`advisorConfig`.

A key outside that list is ignored when it appears in `modelSettings.json`. The
reader drops it before validation, so a bad key cannot take the whole provider
configuration down with it.

## Project configuration

A project can hold `.claude/` or `.freecode/`. Both are read. `.freecode/` wins,
because it merges last. New files are always created in `.freecode/`. See
[src/utils/projectConfigPaths.ts](../src/utils/projectConfigPaths.ts).

Settings merge in this order, and the last one wins:

user, then project, then local, then a command-line flag.

## Providers

A provider entry names a wire format, an authentication method, a cache strategy
and a model list. The schema is in
[src/utils/settings/types.ts](../src/utils/settings/types.ts).

### Wire formats

| Type                      | Talks to                                   |
| ------------------------- | ------------------------------------------ |
| `anthropic`               | The Anthropic Messages API                 |
| `openai-responses`        | The OpenAI Responses API, which Codex uses |
| `openai-chat-completions` | Any OpenAI-compatible endpoint             |
| `bedrock-converse`        | Amazon Bedrock Converse                    |
| `vertex`                  | Google Cloud Vertex AI                     |
| `foundry`                 | Anthropic on Azure AI Foundry              |
| `gemini`                  | Google Gemini                              |

`openai-chat-completions` covers Groq, Together, DeepSeek, OpenRouter, vLLM and
`llama-server`.

### Authentication methods

`apiKey`, `bearer`, `oauth`, `gcp`, `aws` and `azure`.

A provider type does not imply a method. A Bedrock provider acquires AWS
credentials itself, and a Gemini provider builds its own Google auth client.

### Cache strategies

`explicit-breakpoint`, `automatic-prefix` and `none`.

## Built-in model presets

[src/utils/model/providerPresets.ts](../src/utils/model/providerPresets.ts)
carries a default model list for five providers. Each list holds the same four
models under the identifier that the provider expects.

| Provider  | Opus 4.7                       | Opus 4.6                          | Sonnet 4.6                       | Haiku 4.5                                     |
| --------- | ------------------------------ | --------------------------------- | -------------------------------- | --------------------------------------------- |
| Anthropic | `claude-opus-4-7`              | `claude-opus-4-6`                 | `claude-sonnet-4-6`              | `claude-haiku-4-5-20251001`                   |
| Bedrock   | `us.anthropic.claude-opus-4-7` | `us.anthropic.claude-opus-4-6-v1` | `us.anthropic.claude-sonnet-4-6` | `us.anthropic.claude-haiku-4-5-20251001-v1:0` |
| Vertex    | `claude-opus-4-7`              | `claude-opus-4-6`                 | `claude-sonnet-4-6`              | `claude-haiku-4-5@20251001`                   |
| Foundry   | `claude-opus-4-7`              | `claude-opus-4-6`                 | `claude-sonnet-4-6`              | `claude-haiku-4-5`                            |

The Codex preset is different:

| Model               | ID                    |
| ------------------- | --------------------- |
| GPT-5.4             | `gpt-5.4`             |
| GPT-5.3 Codex       | `gpt-5.3-codex`       |
| GPT-5.4 Mini        | `gpt-5.4-mini`        |
| GPT-5.3 Codex Spark | `gpt-5.3-codex-spark` |

A preset entry also carries the context window, the output limit, the price and
the effort levels. Price matters beyond billing, because at least one prompt
decision reads it.

## Legacy environment variables

Four switches select a provider:

`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`
and `CLAUDE_CODE_USE_OPENAI`.

Two facts about them are easy to get wrong:

- They are tested in that order, in one `if`/`else` chain. Only the first truthy switch has an effect. Anthropic is the final `else`, so it has no switch of its own.
- They do not build a provider on every start. They feed a one-shot migration that runs only when `freecode.json` is absent, a legacy settings file exists, and the user accepts the prompt. The migration then writes a real provider into `modelSettings.json`.

Read [src/utils/model/legacyProviderMigration.ts](../src/utils/model/legacyProviderMigration.ts)
before you rely on this path. Prefer to write the provider yourself.

## Environment variables

### Provider selection

| Variable                  | Purpose                         |
| ------------------------- | ------------------------------- |
| `CLAUDE_CODE_USE_BEDROCK` | Select Bedrock during migration |
| `CLAUDE_CODE_USE_VERTEX`  | Select Vertex during migration  |
| `CLAUDE_CODE_USE_FOUNDRY` | Select Foundry during migration |
| `CLAUDE_CODE_USE_OPENAI`  | Select Codex during migration   |

### Anthropic

| Variable                            | Purpose                          |
| ----------------------------------- | -------------------------------- |
| `ANTHROPIC_API_KEY`                 | API key                          |
| `ANTHROPIC_AUTH_TOKEN`              | Bearer token                     |
| `ANTHROPIC_BASE_URL`                | Custom endpoint                  |
| `CLAUDE_CODE_OAUTH_TOKEN`           | OAuth token from the environment |
| `CLAUDE_CODE_API_KEY_HELPER_TTL_MS` | Key-helper cache lifetime        |

### Amazon Bedrock

| Variable                           | Purpose                            |
| ---------------------------------- | ---------------------------------- |
| `AWS_REGION`, `AWS_DEFAULT_REGION` | Region. The default is `us-east-1` |
| `AWS_PROFILE`                      | Named credentials profile          |
| `AWS_BEARER_TOKEN_BEDROCK`         | Bearer token                       |
| `ANTHROPIC_BEDROCK_BASE_URL`       | Custom endpoint                    |
| `CLAUDE_CODE_SKIP_BEDROCK_AUTH`    | Skip authentication, for tests     |

### Google Vertex AI

| Variable                         | Purpose                        |
| -------------------------------- | ------------------------------ |
| `CLOUD_ML_REGION`                | Region                         |
| `ANTHROPIC_VERTEX_PROJECT_ID`    | GCP project                    |
| `ANTHROPIC_VERTEX_BASE_URL`      | Custom endpoint                |
| `GOOGLE_APPLICATION_CREDENTIALS` | Service-account key file       |
| `CLAUDE_CODE_SKIP_VERTEX_AUTH`   | Skip authentication, for tests |

Vertex otherwise uses Application Default Credentials. Run
`gcloud auth application-default login`.

### Azure AI Foundry

| Variable                        | Purpose                                     |
| ------------------------------- | ------------------------------------------- |
| `ANTHROPIC_FOUNDRY_RESOURCE`    | Resource name, which builds the endpoint    |
| `ANTHROPIC_FOUNDRY_BASE_URL`    | Endpoint, if you set it directly            |
| `ANTHROPIC_FOUNDRY_API_KEY`     | API key. Without it, Azure identity is used |
| `CLAUDE_CODE_SKIP_FOUNDRY_AUTH` | Skip authentication, for tests              |

### Models and tokens

| Variable                        | Purpose                  |
| ------------------------------- | ------------------------ |
| `ANTHROPIC_MODEL`               | Main-loop model          |
| `ANTHROPIC_SMALL_FAST_MODEL`    | Small, fast model        |
| `CLAUDE_CODE_SUBAGENT_MODEL`    | Model for every subagent |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | Output-token ceiling     |
| `MAX_THINKING_TOKENS`           | Reasoning-token ceiling  |
| `DISABLE_PROMPT_CACHING`        | Turn prompt caching off  |

`DISABLE_PROMPT_CACHING_HAIKU`, `_SONNET` and `_OPUS` turn it off per tier.

### Tools and protocols

| Variable                                         | Purpose                                   |
| ------------------------------------------------ | ----------------------------------------- |
| `ENABLE_LSP_TOOL`                                | Add the LSP tool, which is off by default |
| `MCP_TIMEOUT`, `MCP_TOOL_TIMEOUT`                | MCP connection and call timeouts          |
| `MAX_MCP_OUTPUT_TOKENS`                          | MCP result ceiling                        |
| `USE_BUILTIN_RIPGREP`                            | Use the bundled ripgrep, not a system one |
| `BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS` | Bash timeouts                             |
| `BASH_MAX_OUTPUT_LENGTH`                         | Bash output ceiling                       |

### Location and behavior

| Variable                             | Purpose                                                 |
| ------------------------------------ | ------------------------------------------------------- |
| `FREECODE_CONFIG_DIR`                | Configuration home. `CLAUDE_CONFIG_DIR` is the fallback |
| `CLAUDE_CODE_SIMPLE`                 | Minimal mode                                            |
| `DISABLE_AUTOUPDATER`                | Turn the updater off                                    |
| `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` | Leave the terminal title alone                          |

### Network

`HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` are read in both cases.
`NODE_EXTRA_CA_CERTS` and `NODE_TLS_REJECT_UNAUTHORIZED` apply to TLS.

[src/utils/managedEnvConstants.ts](../src/utils/managedEnvConstants.ts) holds the
full list that the CLI treats as user-configurable.
