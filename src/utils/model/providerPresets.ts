import type { ProviderModelConfig } from '../settings/types.js'

// ── Default Claude models ────────────────────────────────────────────

// Shared capability presets for Claude models (1P / Foundry)
export const CLAUDE_46_CAPS = {
  thinking: true,
  adaptiveThinking: true,
  interleavedThinking: true,
  serverContextManagement: true,
  structuredOutputs: true,
} as const

export const CLAUDE_4X_CAPS = {
  thinking: true,
  adaptiveThinking: false,
  interleavedThinking: true,
  serverContextManagement: true,
  structuredOutputs: true,
} as const

// 3P (Bedrock/Vertex) — no server context management or structured outputs betas
export const CLAUDE_46_3P_CAPS = {
  thinking: true,
  adaptiveThinking: true,
  interleavedThinking: true,
  serverContextManagement: false,
  structuredOutputs: false,
} as const

export const CLAUDE_4X_3P_CAPS = {
  thinking: true,
  adaptiveThinking: false,
  interleavedThinking: true,
  serverContextManagement: false,
  structuredOutputs: false,
} as const

// ── Pricing presets (per Mtok, USD) ──────────────────────────────────
// @see https://platform.claude.com/docs/en/about-claude/pricing

export const SONNET_PRICING = {
  input: 3,
  output: 15,
  cacheWrite: 3.75,
  cacheRead: 0.3,
  webSearch: 0.01,
} as const

export const OPUS_46_PRICING = {
  input: 5,
  output: 25,
  cacheWrite: 6.25,
  cacheRead: 0.5,
  webSearch: 0.01,
} as const

export const HAIKU_45_PRICING = {
  input: 1,
  output: 5,
  cacheWrite: 1.25,
  cacheRead: 0.1,
  webSearch: 0.01,
} as const

export const DEFAULT_ANTHROPIC_MODELS: ProviderModelConfig[] = [
  {
    id: 'claude-opus-4-7',
    label: 'Opus 4.7',

    description: 'Most capable',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,

    pricing: OPUS_46_PRICING,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'xhigh',
    ...CLAUDE_46_CAPS,
  },
  {
    id: 'claude-opus-4-6',
    label: 'Opus 4.6',

    description: 'Most capable',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,

    pricing: OPUS_46_PRICING,
    effortLevels: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
    ...CLAUDE_46_CAPS,
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',

    description: 'Fast and capable',
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,

    pricing: SONNET_PRICING,
    effortLevels: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
    ...CLAUDE_46_CAPS,
  },
  {
    id: 'claude-haiku-4-5-20251001',
    label: 'Haiku 4.5',

    description: 'Fastest',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    pricing: HAIKU_45_PRICING,
    ...CLAUDE_4X_CAPS,
  },
]

export const DEFAULT_BEDROCK_MODELS: ProviderModelConfig[] = [
  {
    id: 'us.anthropic.claude-opus-4-7',
    label: 'Opus 4.7',

    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,

    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'xhigh',
    ...CLAUDE_46_3P_CAPS,
  },
  {
    id: 'us.anthropic.claude-opus-4-6-v1',
    label: 'Opus 4.6',

    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,

    effortLevels: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
    ...CLAUDE_46_3P_CAPS,
  },
  {
    id: 'us.anthropic.claude-sonnet-4-6',
    label: 'Sonnet 4.6',

    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,

    effortLevels: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
    ...CLAUDE_46_3P_CAPS,
  },
  {
    id: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    label: 'Haiku 4.5',

    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    ...CLAUDE_4X_3P_CAPS,
  },
]

export const DEFAULT_VERTEX_MODELS: ProviderModelConfig[] = [
  {
    id: 'claude-opus-4-7',
    label: 'Opus 4.7',

    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,

    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'xhigh',
    ...CLAUDE_46_3P_CAPS,
  },
  {
    id: 'claude-opus-4-6',
    label: 'Opus 4.6',

    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,

    effortLevels: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
    ...CLAUDE_46_3P_CAPS,
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',

    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,

    effortLevels: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
    ...CLAUDE_46_3P_CAPS,
  },
  {
    id: 'claude-haiku-4-5@20251001',
    label: 'Haiku 4.5',

    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    ...CLAUDE_4X_3P_CAPS,
  },
]

export const DEFAULT_FOUNDRY_MODELS: ProviderModelConfig[] = [
  {
    id: 'claude-opus-4-7',
    label: 'Opus 4.7',

    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,

    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultEffort: 'xhigh',
    ...CLAUDE_46_CAPS,
  },
  {
    id: 'claude-opus-4-6',
    label: 'Opus 4.6',

    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,

    effortLevels: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
    ...CLAUDE_46_CAPS,
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Sonnet 4.6',

    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,

    effortLevels: ['low', 'medium', 'high', 'max'],
    defaultEffort: 'high',
    ...CLAUDE_46_CAPS,
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',

    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    ...CLAUDE_4X_CAPS,
  },
]

// OpenAI models: thinking translated to reasoning_effort by adapter
export const OPENAI_CAPS = {
  thinking: true,
  adaptiveThinking: false,
  interleavedThinking: false,
  serverContextManagement: false,
  structuredOutputs: false,
} as const

export const DEFAULT_CODEX_MODELS: ProviderModelConfig[] = [
  {
    id: 'gpt-5.4',
    label: 'GPT-5.4',

    description: 'Latest GPT',
    contextWindow: 1_050_000,
    maxOutputTokens: 128_000,
    effortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
    ...OPENAI_CAPS,
  },
  {
    id: 'gpt-5.3-codex',
    label: 'GPT-5.3 Codex',

    description: 'Frontier agentic coding',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    effortLevels: ['low', 'medium', 'high', 'xhigh'],
    ...OPENAI_CAPS,
  },
  {
    id: 'gpt-5.4-mini',
    label: 'GPT-5.4 Mini',

    description: 'Fast GPT',
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    effortLevels: ['none', 'low', 'medium', 'high', 'xhigh'],
    ...OPENAI_CAPS,
  },
  {
    id: 'gpt-5.3-codex-spark',
    label: 'GPT-5.3 Codex Spark',

    description: 'Real-time coding, 1000+ tok/s',
    contextWindow: 128_000,
    maxOutputTokens: 128_000,
    effortLevels: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    ...OPENAI_CAPS,
  },
]
