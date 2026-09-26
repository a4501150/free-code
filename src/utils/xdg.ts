/**
 * XDG Base Directory utilities for Claude CLI Native Installer
 *
 * Implements the XDG Base Directory specification for organizing
 * native installer components across appropriate system directories.
 *
 * @see https://specifications.freedesktop.org/basedir-spec/latest/
 */

import { homedir as osHomedir } from 'os'

type EnvLike = Record<string, string | undefined>

type XDGOptions = {
  env?: EnvLike
  homedir?: string
}

function resolveOptions(options?: XDGOptions): { env: EnvLike; home: string } {
  return {
    env: options?.env ?? process.env,
    home: options?.homedir ?? process.env.HOME ?? osHomedir(),
  }
}
