import { prependBullets } from '../../constants/prompts.js'
import { getAttributionTexts } from '../../utils/attribution.js'
import { shouldPreferBashForSearch } from '../../utils/embeddedTools.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { shouldIncludeGitInstructions } from '../../utils/gitSettings.js'
import { getClaudeTempDir } from '../../utils/permissions/filesystem.js'
import { SandboxManager } from '../../utils/sandbox/sandbox-adapter.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import {
  getDefaultBashTimeoutMs,
  getMaxBashTimeoutMs,
} from '../../utils/timeouts.js'
import { FILE_EDIT_TOOL_NAME } from '../FileEditTool/constants.js'
import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { FILE_WRITE_TOOL_NAME } from '../FileWriteTool/prompt.js'
import { GLOB_TOOL_NAME } from '../GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../GrepTool/prompt.js'

export function getDefaultTimeoutMs(): number {
  return getDefaultBashTimeoutMs()
}

export function getMaxTimeoutMs(): number {
  return getMaxBashTimeoutMs()
}

function getBackgroundUsageNote(): string | null {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)) {
    return null
  }
  return 'If you find yourself reaching for `sleep` or a poll loop to wait for a command — whether about to run it, or one you have already started — use `run_in_background: true` instead. Control returns immediately and the full output arrives in a later turn as a system notification.'
}

function getCommitAndPRInstructions(): string {
  if (!shouldIncludeGitInstructions()) return ''

  const { commit: commitAttribution, pr: prAttribution } = getAttributionTexts()

  const commitLine = commitAttribution
    ? `- For git commits, pass multi-line messages via a HEREDOC (\`git commit -m "$(cat <<'EOF' ... EOF\n)"\`) to preserve newlines and avoid shell-escaping issues. Include \`${commitAttribution}\` at the end of the message.`
    : `- For git commits, pass multi-line messages via a HEREDOC (\`git commit -m "$(cat <<'EOF' ... EOF\n)"\`) to preserve newlines and avoid shell-escaping issues.`

  const prLine = prAttribution
    ? `- For \`gh pr create\`, pass the body via a HEREDOC (same pattern). End the body with \`${prAttribution}\`.`
    : `- For \`gh pr create\`, pass the body via a HEREDOC (same pattern).`

  return `# Git commits and pull requests

${commitLine}
${prLine}`
}

// SandboxManager merges config from multiple sources (settings layers, defaults,
// CLI flags) without deduping, so paths like ~/.cache appear 3× in allowOnly.
// Dedup here before inlining into the prompt — affects only what the model sees,
// not sandbox enforcement. Saves ~150-200 tokens/request when sandbox is enabled.
function dedup<T>(arr: T[] | undefined): T[] | undefined {
  if (!arr || arr.length === 0) return arr
  return [...new Set(arr)]
}

function getSimpleSandboxSection(): string {
  if (!SandboxManager.isSandboxingEnabled()) {
    return ''
  }

  const fsReadConfig = SandboxManager.getFsReadConfig()
  const fsWriteConfig = SandboxManager.getFsWriteConfig()
  const networkRestrictionConfig = SandboxManager.getNetworkRestrictionConfig()
  const allowUnixSockets = SandboxManager.getAllowUnixSockets()
  const ignoreViolations = SandboxManager.getIgnoreViolations()
  const allowUnsandboxedCommands =
    SandboxManager.areUnsandboxedCommandsAllowed()

  // Replace the per-UID temp dir literal (e.g. /private/tmp/claude-1001/) with
  // "$TMPDIR" so the prompt is identical across users — avoids busting the
  // cross-user global prompt cache. The sandbox already sets $TMPDIR at runtime.
  const claudeTempDir = getClaudeTempDir()
  const normalizeAllowOnly = (paths: string[]): string[] =>
    [...new Set(paths)].map(p => (p === claudeTempDir ? '$TMPDIR' : p))

  const filesystemConfig = {
    read: {
      denyOnly: dedup(fsReadConfig.denyOnly),
      ...(fsReadConfig.allowWithinDeny && {
        allowWithinDeny: dedup(fsReadConfig.allowWithinDeny),
      }),
    },
    write: {
      allowOnly: normalizeAllowOnly(fsWriteConfig.allowOnly),
      denyWithinAllow: dedup(fsWriteConfig.denyWithinAllow),
    },
  }

  const networkConfig = {
    ...(networkRestrictionConfig?.allowedHosts && {
      allowedHosts: dedup(networkRestrictionConfig.allowedHosts),
    }),
    ...(networkRestrictionConfig?.deniedHosts && {
      deniedHosts: dedup(networkRestrictionConfig.deniedHosts),
    }),
    ...(allowUnixSockets && { allowUnixSockets: dedup(allowUnixSockets) }),
  }

  const restrictionsLines = []
  if (Object.keys(filesystemConfig).length > 0) {
    restrictionsLines.push(`Filesystem: ${jsonStringify(filesystemConfig)}`)
  }
  if (Object.keys(networkConfig).length > 0) {
    restrictionsLines.push(`Network: ${jsonStringify(networkConfig)}`)
  }
  if (ignoreViolations) {
    restrictionsLines.push(
      `Ignored violations: ${jsonStringify(ignoreViolations)}`,
    )
  }

  const sandboxOverrideItems: Array<string | string[]> =
    allowUnsandboxedCommands
      ? [
          'You should always default to running commands within the sandbox. Do NOT attempt to set `dangerouslyDisableSandbox: true` unless:',
          [
            'The user *explicitly* asks you to bypass sandbox',
            'A specific command just failed and you see evidence of sandbox restrictions causing the failure. Note that commands can fail for many reasons unrelated to the sandbox (missing files, wrong arguments, network issues, etc.).',
          ],
          'Evidence of sandbox-caused failures includes:',
          [
            '"Operation not permitted" errors for file/network operations',
            'Access denied to specific paths outside allowed directories',
            'Network connection failures to non-whitelisted hosts',
            'Unix socket connection errors',
          ],
          'When you see evidence of sandbox-caused failure:',
          [
            "Immediately retry with `dangerouslyDisableSandbox: true` (don't ask, just do it)",
            'Briefly explain what sandbox restriction likely caused the failure. Be sure to mention that the user can use the `/sandbox` command to manage restrictions.',
            'This will prompt the user for permission',
          ],
          'Treat each command you execute with `dangerouslyDisableSandbox: true` individually. Even if you have recently run a command with this setting, you should default to running future commands within the sandbox.',
          'Do not suggest adding sensitive paths like ~/.bashrc, ~/.zshrc, ~/.ssh/*, or credential files to the sandbox allowlist.',
        ]
      : [
          'All commands MUST run in sandbox mode - the `dangerouslyDisableSandbox` parameter is disabled by policy.',
          'Commands cannot run outside the sandbox under any circumstances.',
          'If a command fails due to sandbox restrictions, work with the user to adjust sandbox settings instead.',
        ]

  const items: Array<string | string[]> = [
    ...sandboxOverrideItems,
    'For temporary files, always use the `$TMPDIR` environment variable. TMPDIR is automatically set to the correct sandbox-writable directory in sandbox mode. Do NOT use `/tmp` directly - use `$TMPDIR` instead.',
  ]

  return [
    '',
    '## Command sandbox',
    'By default, your command will be run in a sandbox. This sandbox controls which directories and network hosts commands may access or modify without an explicit override.',
    '',
    'The sandbox has the following restrictions:',
    restrictionsLines.join('\n'),
    '',
    ...prependBullets(items),
  ].join('\n')
}

export function getSimplePrompt(): string {
  // When Glob/Grep are stripped from the registry, we don't steer away from
  // find/grep in Bash.
  const embedded = shouldPreferBashForSearch()

  const toolPreferenceItems = [
    ...(embedded
      ? []
      : [
          `File search: Use ${GLOB_TOOL_NAME} (NOT find or ls)`,
          `Content search: Use ${GREP_TOOL_NAME} (NOT grep or rg)`,
        ]),
    `Read files: Use ${FILE_READ_TOOL_NAME} (NOT cat/head/tail)`,
    `Edit files: Use ${FILE_EDIT_TOOL_NAME} (NOT sed/awk)`,
    `Write files: Use ${FILE_WRITE_TOOL_NAME} (NOT echo >/cat <<EOF)`,
    'Communication: Output text directly (NOT echo/printf)',
  ]

  const backgroundNote = getBackgroundUsageNote()

  const instructionItems: Array<string | string[]> = [
    'Always quote file paths that contain spaces with double quotes in your command (e.g., cd "path with spaces/file.txt")',
    'Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of `cd`. You may use `cd` if the User explicitly requests it.',
    `You may specify an optional timeout in milliseconds (up to ${getMaxTimeoutMs()}ms / ${getMaxTimeoutMs() / 60000} minutes). By default, your command will timeout after ${getDefaultTimeoutMs()}ms (${getDefaultTimeoutMs() / 60000} minutes).`,
    ...(backgroundNote !== null ? [backgroundNote] : []),
    ...(embedded
      ? [
          // bfs (which backs `find`) uses Oniguruma for -regex, which picks the
          // FIRST matching alternative (leftmost-first), unlike GNU find's
          // POSIX leftmost-longest. This silently drops matches when a shorter
          // alternative is a prefix of a longer one.
          "When using `find -regex` with alternation, put the longest alternative first. Example: use `'.*\\.\\(tsx\\|ts\\)'` not `'.*\\.\\(ts\\|tsx\\)'` — the second form silently skips `.tsx` files.",
        ]
      : []),
  ]

  return [
    'Executes a given bash command and returns its output. The working directory persists between commands, but shell state does not.',
    '',
    'Prefer dedicated tools over bash equivalents:',
    ...prependBullets(toolPreferenceItems),
    '',
    '# Instructions',
    ...prependBullets(instructionItems),
    getSimpleSandboxSection(),
    ...(getCommitAndPRInstructions() ? ['', getCommitAndPRInstructions()] : []),
  ].join('\n')
}
