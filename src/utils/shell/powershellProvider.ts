import { tmpdir } from 'os'
import { join } from 'path'
import { getSessionEnvVars } from '../sessionEnvVars.js'
import type { ShellProvider } from './shellProvider.js'

/**
 * PowerShell invocation flags + command. Shared by the provider's getSpawnArgs
 * and the hook spawn path in hooks.ts so the flag set stays in one place.
 */
export function buildPowerShellArgs(cmd: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-Command', cmd]
}

export function createPowerShellProvider(shellPath: string): ShellProvider {
  return {
    type: 'powershell' as ShellProvider['type'],
    shellPath,
    detached: false,

    async buildExecCommand(
      command: string,
      opts: {
        id: number | string
      },
    ): Promise<{ commandString: string; cwdFilePath: string }> {
      const cwdFilePath = join(tmpdir(), `claude-pwd-ps-${opts.id}`)
      const escapedCwdFilePath = cwdFilePath.replace(/'/g, "''")
      // Exit-code capture: prefer $LASTEXITCODE when a native exe ran.
      // On PS 5.1, a native command that writes to stderr while the stream
      // is PS-redirected (e.g. `git push 2>&1`) sets $? = $false even when
      // the exe returned exit 0 — so `if (!$?)` reports a false positive.
      // $LASTEXITCODE is $null only when no native exe has run in the
      // session; in that case fall back to $? for cmdlet-only pipelines.
      // Tradeoff: `native-ok; cmdlet-fail` now returns 0 (was 1). Reverse
      // is also true: `native-fail; cmdlet-ok` now returns the native
      // exit code (was 0 — old logic only looked at $? which the trailing
      // cmdlet set true). Both rarer than the git/npm/curl stderr case.
      const cwdTracking = `\n; $_ec = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } elseif ($?) { 0 } else { 1 }\n; (Get-Location).Path | Out-File -FilePath '${escapedCwdFilePath}' -Encoding utf8 -NoNewline\n; exit $_ec`
      const commandString = command + cwdTracking

      return { commandString, cwdFilePath }
    },

    getSpawnArgs(commandString: string): string[] {
      return buildPowerShellArgs(commandString)
    },

    async getEnvironmentOverrides(): Promise<Record<string, string>> {
      const env: Record<string, string> = {}
      // Apply session env vars set via /env (child processes only, not
      // the REPL). Without this, `/env PATH=...` affects Bash tool
      // commands but not PowerShell — so PyCharm users with a stripped
      // PATH can't self-rescue.
      for (const [key, value] of getSessionEnvVars()) {
        env[key] = value
      }
      return env
    },
  }
}
