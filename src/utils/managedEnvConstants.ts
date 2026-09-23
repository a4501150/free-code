/**
 * Transport and credential variables a host owns when it sets
 * CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST. Provider selection, endpoints and
 * models are configured in the settings files (the providers block), never
 * via env, so this set only covers what the host injects at spawn time plus
 * credentials — a user's ~/.freecode/freecode.json `env` must not override
 * the host's transport base URL or credentials.
 */
const PROVIDER_MANAGED_ENV_VARS = new Set([
  // The flag itself — settings can't unset it once the host set it
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  // Host-spawn transport endpoint
  'ANTHROPIC_BASE_URL',
  // Auth
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
])

export function isProviderManagedEnvVar(key: string): boolean {
  return PROVIDER_MANAGED_ENV_VARS.has(key.toUpperCase())
}

/**
 * Dangerous shell settings that can execute arbitrary shell code
 */
export const DANGEROUS_SHELL_SETTINGS = [
  'apiKeyHelper',
  'awsAuthRefresh',
  'awsCredentialExport',
  'gcpAuthRefresh',
  'otelHeadersHelper',
  'statusLine',
] as const

/**
 * Safe environment variables that can be applied before trust dialog:
 * names our code or an in-process SDK (OpenTelemetry, AWS) honors that
 * don't pose security risks. Behavior switches that moved to settings
 * keys are deliberately absent — an env var no one reads has no place
 * here, since its presence would only widen the pre-trust applied set.
 *
 * IMPORTANT: This is the source of truth for which env vars are safe.
 * Any env var NOT in this list is considered dangerous and will trigger
 * a security dialog when set via remote managed settings.
 *
 * Dangerous env vars (NOT in this list):
 *
 * === REDIRECT TO ATTACKER-CONTROLLED SERVER ===
 * - ANTHROPIC_BASE_URL
 * - HTTP_PROXY, HTTPS_PROXY, NO_PROXY, http_proxy, https_proxy, no_proxy
 * - OTEL_EXPORTER_OTLP_ENDPOINT, OTEL_EXPORTER_OTLP_LOGS_ENDPOINT, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT
 *
 * === TRUST ATTACKER-CONTROLLED SERVER ===
 * - NODE_TLS_REJECT_UNAUTHORIZED
 * - NODE_EXTRA_CA_CERTS
 *
 * === SWITCH TO ATTACKER-CONTROLLED PROJECT ===
 * - ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN
 * - AWS_BEARER_TOKEN_BEDROCK
 */
export const SAFE_ENV_VARS = new Set([
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_REGION',
  'BASH_DEFAULT_TIMEOUT_MS',
  'BASH_MAX_OUTPUT_LENGTH',
  'BASH_MAX_TIMEOUT_MS',
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'DISABLE_AUTOUPDATER',
  'DISABLE_COST_WARNINGS',
  'DISABLE_ERROR_REPORTING',
  'MAX_MCP_OUTPUT_TOKENS',
  'MAX_THINKING_TOKENS',
  'MCP_TIMEOUT',
  'MCP_TOOL_TIMEOUT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_METRICS_CLIENT_CERTIFICATE',
  'OTEL_EXPORTER_OTLP_METRICS_CLIENT_KEY',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_PROTOCOL',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  'OTEL_LOG_TOOL_DETAILS',
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_LOGS_EXPORT_INTERVAL',
  'OTEL_LOGS_EXPORTER',
  'OTEL_METRIC_EXPORT_INTERVAL',
  'OTEL_METRICS_EXPORTER',
  'OTEL_METRICS_INCLUDE_ACCOUNT_UUID',
  'OTEL_METRICS_INCLUDE_SESSION_ID',
  'OTEL_METRICS_INCLUDE_VERSION',
  'OTEL_RESOURCE_ATTRIBUTES',
  'USE_BUILTIN_RIPGREP',
])
