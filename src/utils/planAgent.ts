import { feature } from 'bun:bundle'
import { getInitialSettings } from './settings/settings.js'

type PlanAgentConfig = {
  enabled?: boolean
  planModel?: string
}

export function getPlanAgentConfig(): PlanAgentConfig {
  return getInitialSettings()?.planAgentConfig ?? {}
}

export function isBuiltInPlanAgentEnabled(): boolean {
  if (!feature('BUILTIN_EXPLORE_PLAN_AGENTS')) return false
  return getPlanAgentConfig().enabled === true
}
