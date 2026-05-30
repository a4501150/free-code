import type { Command } from '../../commands.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'

const exit = {
  type: 'local-jsx',
  name: 'exit',
  aliases: ['quit'],
  description: 'Exit the REPL',
  immediate: true,
  call: (onDone: LocalJSXCommandOnDone) =>
    import('./exit.js').then(mod => mod.call(onDone)),
} satisfies Command

export default exit
