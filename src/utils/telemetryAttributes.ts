import { isEnvTruthy } from './envUtils.js'

// Default configuration for metrics cardinality
const METRICS_CARDINALITY_DEFAULTS = {
  OTEL_METRICS_INCLUDE_SESSION_ID: true,
  OTEL_METRICS_INCLUDE_VERSION: false,
  OTEL_METRICS_INCLUDE_ACCOUNT_UUID: true,
}

function shouldIncludeAttribute(
  envVar: keyof typeof METRICS_CARDINALITY_DEFAULTS,
): boolean {
  const defaultValue = METRICS_CARDINALITY_DEFAULTS[envVar]
  const envValue = process.env[envVar]

  if (envValue === undefined) {
    return defaultValue
  }

  return isEnvTruthy(envValue)
}
