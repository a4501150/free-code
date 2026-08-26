import { getInitialSettings } from './settings/settings.js'

type PlanAgentConfig = {
  enabled?: boolean
  planModel?: string
}

export function getPlanAgentConfig(): PlanAgentConfig {
  return getInitialSettings()?.planAgentConfig ?? {}
}
