import type { Command } from '@commander-js/extra-typings'
import { writeFile } from 'fs/promises'
import { resolve } from 'path'
import { errorMessage } from '../utils/errors.js'
import { logError } from '../utils/log.js'

type Shell = 'bash' | 'zsh' | 'fish'

/**
 * `claude completion <shell>`
 *
 * Emits a shell completion script (bash/zsh/fish) to stdout, or to a file when
 * `--output <path>` is given. The emitted scripts offer top-level command and
 * option completion based on the live commander registry.
 */
export async function completionHandler(
  shell: string,
  opts: { output?: string },
  program: Command,
): Promise<void> {
  if (shell !== 'bash' && shell !== 'zsh' && shell !== 'fish') {
    // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
    console.error(
      `Unsupported shell "${shell}". Expected one of: bash, zsh, fish`,
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  const script = generateCompletionScript(shell, program)

  if (opts.output) {
    try {
      await writeFile(resolve(opts.output), script, { encoding: 'utf-8' })
    } catch (e) {
      logError(e)
      // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
      console.error(
        `Failed to write completion to ${opts.output}: ${errorMessage(e)}`,
      )
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
  } else {
    process.stdout.write(script)
  }
}

function generateCompletionScript(shell: Shell, program: Command): string {
  const progName = program.name() || 'claude'
  const subcommands = program.commands.map(c => c.name()).filter(Boolean)

  // Collect top-level option flags (both long and short).
  const flagSet = new Set<string>()
  for (const opt of program.options) {
    for (const flag of opt.flags.split(/,\s*|\s+/)) {
      if (flag.startsWith('-')) {
        flagSet.add(flag.replace(/[=<].*/, ''))
      }
    }
  }
  const flags = Array.from(flagSet).sort()

  const words = [...subcommands, ...flags].join(' ')

  switch (shell) {
    case 'bash':
      return `# ${progName} bash completion
_${progName}_complete() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  COMPREPLY=( $(compgen -W "${words}" -- "$cur") )
  return 0
}
complete -F _${progName}_complete ${progName}
`

    case 'zsh':
      return `#compdef ${progName}
# ${progName} zsh completion
_${progName}() {
  local -a options
  options=(${words
    .split(' ')
    .map(w => `'${w}'`)
    .join(' ')})
  _describe '${progName} completions' options
}
compdef _${progName} ${progName}
`

    case 'fish':
      return `# ${progName} fish completion
${words
  .split(' ')
  .map(w => `complete -c ${progName} -a '${w}'`)
  .join('\n')}
`
  }
}
