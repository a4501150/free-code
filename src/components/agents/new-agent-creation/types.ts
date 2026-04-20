import type { AgentDefinition } from '../../../tools/AgentTool/loadAgentsDir.js'
import type { SettingSource } from '../../../utils/settings/constants.js'

/**
 * Shared wizard state for the "create new agent" flow. Each step in
 * src/components/agents/new-agent-creation/wizard-steps/ reads and
 * writes slices of this object through useWizard<AgentWizardData>().
 */
export type AgentWizardData = {
  /**
   * 'generate' → generate the agent definition with an LLM.
   * 'manual' → user fills the fields directly.
   */
  method?: 'generate' | 'manual'
  /** Whether the final agent was produced via the generate flow. */
  wasGenerated?: boolean
  /** LLM-facing prompt used by the generate flow. */
  generationPrompt?: string
  /** Short identifier / "kind" (e.g. `code-reviewer`). */
  agentType?: string
  /** Natural-language description of when the agent should be used. */
  whenToUse?: string
  /** The agent's system prompt. */
  systemPrompt?: string
  /** Tool names allowed for the agent. */
  selectedTools?: string[]
  /** Model identifier override (when the user picks something specific). */
  selectedModel?: string
  /** Agent accent color. */
  selectedColor?: string
  /** Human-readable description (rendered in confirmation, etc.). */
  description?: string
  /** Settings source to save into (userSettings, projectSettings, …). */
  location?: SettingSource
  /** Fully-resolved agent definition after all prior steps completed. */
  finalAgent?: AgentDefinition
  /** LLM-generated agent data from the generate flow. */
  generatedAgent?: unknown
  /** Whether the generate flow is currently running. */
  isGenerating?: boolean
  /** Selected memory scope for the agent. */
  selectedMemory?: unknown
}

export type { AgentDefinition }
