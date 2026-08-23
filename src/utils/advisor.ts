import type { DomainUsage } from '../types/domain.js'
import { getInitialSettings } from './settings/settings.js'

// Legacy server-side advisor block types — kept for backward compat with
// old conversations that contain server-side advisor blocks.
export type AdvisorServerToolUseBlock = {
  type: 'server_tool_use'
  id: string
  name: 'advisor'
  input: { [key: string]: unknown }
}

export type AdvisorToolResultBlock = {
  type: 'advisor_tool_result'
  tool_use_id: string
  content:
    | {
        type: 'advisor_result'
        text: string
      }
    | {
        type: 'advisor_redacted_result'
        encrypted_content: string
      }
    | {
        type: 'advisor_tool_result_error'
        error_code: string
      }
}

export type AdvisorBlock = AdvisorServerToolUseBlock | AdvisorToolResultBlock

export function isAdvisorBlock(param: {
  type: string
  name?: string
}): param is AdvisorBlock {
  return (
    param.type === 'advisor_tool_result' ||
    (param.type === 'server_tool_use' && param.name === 'advisor')
  )
}

type AdvisorConfig = {
  enabled?: boolean
  advisorModel?: string
}

export function getAdvisorConfig(): AdvisorConfig {
  return getInitialSettings()?.advisorConfig ?? {}
}

export function isAdvisorEnabled(): boolean {
  const config = getAdvisorConfig()
  return (config.enabled ?? false) && !!config.advisorModel
}

// Legacy: extract advisor usage from server-side iterations (old conversations)
export function getAdvisorUsage(
  usage: DomainUsage,
): Array<DomainUsage & { model: string }> {
  const iterations = usage.iterations as
    | Array<{ type: string }>
    | null
    | undefined
  if (!iterations) {
    return []
  }
  return iterations.filter(
    it => it.type === 'advisor_message',
  ) as unknown as Array<DomainUsage & { model: string }>
}
