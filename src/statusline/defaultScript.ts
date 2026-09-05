import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import script from './default-statusline.sh' with { type: 'text' }

let materializedPath: string | undefined

function quoteForBash(path: string): string {
  return `'${path.replaceAll("'", `'\''`)}'`
}

/**
 * Bash command that runs the embedded default status line. The script is
 * materialized once per process under a PID-scoped tmp path so concurrent
 * runs of different versions never overwrite each other's file.
 */
export function getDefaultStatusLineCommand(): string {
  if (materializedPath === undefined) {
    const path = join(
      tmpdir(),
      `free-code-default-statusline-${process.pid}.sh`,
    )
    writeFileSync(path, script, { mode: 0o600 })
    materializedPath = path
  }
  return `bash ${quoteForBash(materializedPath)}`
}
