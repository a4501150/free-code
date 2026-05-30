import type { Command } from '../../commands.js'

const resume: Command = {
  type: 'local-jsx',
  name: 'resume',
  description: 'Resume a previous conversation',
  aliases: ['continue'],
  argumentHint: '[conversation id or search term]',
  call: (...args) =>
    import('./resume.js').then(mod => Reflect.apply(mod.call, undefined, args)),
}

export default resume
