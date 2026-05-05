import { getGlobalConfig } from '../../utils/config.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getInitialSettings } from '../../utils/settings/settings.js'

export const DEFAULT_AUTO_COMPACT_PERCENTAGE = 100
export const MIN_AUTO_COMPACT_PERCENTAGE = 10
export const MAX_AUTO_COMPACT_PERCENTAGE = 100
export const DEFAULT_AUTO_COMPACT_BUFFER = 20_000

export type AutoCompactConfig = {
  percentage: number
  buffer: number
}

function sanitizeAutoCompactPercentage(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_AUTO_COMPACT_PERCENTAGE
  }
  return Math.min(
    MAX_AUTO_COMPACT_PERCENTAGE,
    Math.max(MIN_AUTO_COMPACT_PERCENTAGE, Math.trunc(value)),
  )
}

function sanitizeAutoCompactBuffer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return DEFAULT_AUTO_COMPACT_BUFFER
  }
  return Math.trunc(value)
}

export function getAutoCompactConfig(): AutoCompactConfig {
  const settings = getInitialSettings()
  return {
    percentage: sanitizeAutoCompactPercentage(settings.autoCompactPercentage),
    buffer: sanitizeAutoCompactBuffer(settings.autoCompactBuffer),
  }
}

export function getAutoCompactThresholdForContextWindow(
  contextWindow: number,
): number {
  const { percentage, buffer } = getAutoCompactConfig()
  const bufferThreshold = contextWindow - buffer
  const percentageThreshold = Math.floor(contextWindow * (percentage / 100))

  return Math.max(0, Math.min(bufferThreshold, percentageThreshold))
}

export function isAutoCompactEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_COMPACT)) {
    return false
  }
  if (isEnvTruthy(process.env.DISABLE_AUTO_COMPACT)) {
    return false
  }

  const settings = getInitialSettings()
  if (settings.autoCompactEnabled !== undefined) {
    return settings.autoCompactEnabled
  }

  const userConfig = getGlobalConfig()
  return userConfig.autoCompactEnabled
}
