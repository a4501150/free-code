/**
 * Canonical inventory of CLAUDE_* / ANTHROPIC_* environment variables the
 * process is allowed to read (tests/unit/envAllowlist.test.ts enforces that
 * every `process.env.CLADE_*` / `process.env.ANTHROPIC_*` read site in src/
 * names a variable listed here).
 *
 * User-facing configuration lives in settings files (freecode.json /
 * modelSettings.json) and the /config UI — NOT in env vars. An env read is
 * allowed here only when it falls into one of the three exempt buckets:
 *
 *   AUTH              — credential acquisition. Env is the standard way to
 *                       authenticate CI/headless runs without writing secret
 *                       files or using the keychain.
 *   PROCESS_MECHANICS — process metadata and per-spawn facts: variables we
 *                       write into ourselves as IPC, that the host/SDK injects
 *                       at spawn, or that we inject into hook/skill children.
 *                       These are not user configuration.
 *   DEBUG_OPS         — launch-time operator and diagnostics switches that must
 *                       work before settings load (or with settings broken).
 *
 * TRANSITIONAL holds vars being migrated to settings keys (config-file-first
 * cleanup). Each category commit deletes its names from this group; when the
 * group is empty the whole block goes away.
 *
 * NOTE: `settings.env` (managedEnv.ts) can inject any name into process.env
 * for child processes; that is a passthrough and does not need an entry here.
 * Only *read sites in our own code* are governed by this list.
 */

/** Credential acquisition — see header. */
export const AUTH_ENV_VARS = new Set([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_UNIX_SOCKET', // set by `claude ssh` remote: auth transport, not routing
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_OAUTH_CLIENT_ID',
  'CLAUDE_CODE_CUSTOM_OAUTH_URL',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
  'CLAUDE_CODE_SKIP_VERTEX_AUTH',
  'CLAUDE_CODE_SKIP_FOUNDRY_AUTH',
  'CLAUDE_CODE_CLIENT_CERT',
  'CLAUDE_CODE_CLIENT_KEY',
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'CLAUDE_CODE_ENABLE_XAA',
])

/** Process metadata / IPC / host-injected facts — see header. */
export const PROCESS_MECHANICS_ENV_VARS = new Set([
  // Config home (needed before anything else can load)
  'CLAUDE_CONFIG_DIR',
  // Self-written IPC (main.tsx / entrypoints write these, call sites read)
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SIMPLE', // set from --bare; read by isBareMode()
  'CLAUDE_CODE_TASK_LIST_ID',
  // Injected into hook / MCP-header children
  'CLAUDE_ENV_FILE',
  // Self-injected tmux worktree integration (worktree.ts -> LogoV2 display)
  'CLAUDE_CODE_TMUX_SESSION',
  'CLAUDE_CODE_TMUX_PREFIX',
  'CLAUDE_CODE_TMUX_PREFIX_CONFLICTS',
  // Headless / Cowork host integration
  'CLAUDE_CODE_IS_COWORK',
  'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST',
  'CLAUDE_CODE_HOST_PLATFORM',
  'CLAUDE_CODE_ENVIRONMENT_KIND',
  'CLAUDE_CODE_BUBBLEWRAP',
  'CLAUDE_CODE_TMPDIR',
  'CLAUDE_CODE_USE_COWORK_PLUGINS',
  'CLAUDE_CODE_SYNC_PLUGIN_INSTALL',
  'CLAUDE_CODE_SYNC_PLUGIN_INSTALL_TIMEOUT_MS',
  'CLAUDE_CODE_PLUGIN_SEED_DIR',
  'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE',
  'CLAUDE_COWORK_MEMORY_EXTRA_GUIDELINES',
  // SDK
  'CLAUDE_AGENT_SDK_CLIENT_APP',
  'CLAUDE_AGENT_SDK_VERSION',
  'CLAUDE_AGENT_SDK_MCP_NO_PREFIX',
  'CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS',
  // Host-injected identity
  'CLAUDE_CODE_ACCOUNT_UUID',
  'CLAUDE_CODE_ACCOUNT_TAGGED_ID',
  'CLAUDE_CODE_ORGANIZATION_UUID',
  'CLAUDE_CODE_USER_EMAIL',
  'CLAUDE_CODE_CONTAINER_ID',
  // REPL / print-mode runtime options passed by hosts
  'CLAUDE_CODE_REPL',
  'CLAUDE_REPL_MODE',
  'CLAUDE_CODE_RESUME_INTERRUPTED_TURN',
  'CLAUDE_CODE_INCLUDE_PARTIAL_MESSAGES',
  'CLAUDE_CODE_ACTION',
  'CLAUDE_CODE_ADDITIONAL_PROTECTION',
  'CLAUDE_CODE_QUESTION_PREVIEW_FORMAT',
  // Agent-teams spawn IPC (leader -> teammate)
  'CLAUDE_CODE_PLAN_MODE_REQUIRED',
  // Host-injected transport base URL (claude ssh remote, cowork subprocess).
  // Settings-based routing lives in the providers block; this is spawn-time.
  'ANTHROPIC_BASE_URL',
  // IDE integration injected by the IDE extension at spawn
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_IDE_HOST_OVERRIDE',
])

/** Launch-time operator / diagnostics switches — see header. */
export const DEBUG_OPS_ENV_VARS = new Set([
  'CLAUDE_DEBUG',
  'CLAUDE_CODE_DEBUG_LOG_LEVEL',
  'CLAUDE_CODE_DEBUG_LOGS_DIR',
  'CLAUDE_CODE_DIAGNOSTICS_FILE',
  'CLAUDE_CODE_SKIP_PROMPT_HISTORY',
  'CLAUDE_CODE_PROFILE_STARTUP',
  'CLAUDE_CODE_PROFILE_QUERY',
  'CLAUDE_CODE_PERFETTO_TRACE',
  'CLAUDE_CODE_PERFETTO_WRITE_INTERVAL_S',
  'CLAUDE_CODE_OTEL_HEADERS_HELPER_DEBOUNCE_MS',
  'CLAUDE_CODE_EAGER_FLUSH',
  'CLAUDE_CODE_FRAME_TIMING_LOG',
  'CLAUDE_CODE_DEBUG_REPAINTS',
  'CLAUDE_CODE_COMMIT_LOG',
  'CLAUDE_CODE_EXIT_AFTER_FIRST_RENDER',
  'CLAUDE_ENABLE_STREAM_WATCHDOG',
  // Terminal-color escape hatch for correctly-configured tmux (read in ink)
  'CLAUDE_CODE_TMUX_TRUECOLOR',
  'CLAUDE_STREAM_IDLE_TIMEOUT_MS',
  'CLAUDE_MOCK_HEADERLESS_429',
  'CLAUDE_CODE_TEST_FIXTURES_ROOT',
  'CLAUDE_CODE_OVERRIDE_DATE',
  'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
  'CLAUDE_CODE_DONT_INHERIT_ENV',
  'CLAUDE_CODE_PROXY_RESOLVES_HOSTS',
  // Build-script knobs (scripts/build.ts and friends)
  'CLAUDE_CODE_FORCE_FULL_LOGO',
  'CLAUDE_CODE_VERIFY_PLAN',
  'CLAUDE_CODE_EXPERIMENTAL_BUILD',
])

export const ALLOWED_ENV_VAR_GROUPS = {
  AUTH: AUTH_ENV_VARS,
  PROCESS_MECHANICS: PROCESS_MECHANICS_ENV_VARS,
  DEBUG_OPS: DEBUG_OPS_ENV_VARS,
} as const

/** Every CLAUDE_ or ANTHROPIC_ prefixed name our code may read from process.env. */
export const ALLOWED_ENV_VARS: ReadonlySet<string> = new Set(
  Object.values(ALLOWED_ENV_VAR_GROUPS).flatMap(group => [...group]),
)
