import type { Command } from '../../commands.js'

const installSlackApp = {
  type: 'local',
  name: 'install-slack-app',
  description: 'Install the Claude Slack app',
  availability: ['claude-ai'],
  supportsNonInteractive: false,
  call: (...args) =>
    import('./install-slack-app.js').then(mod =>
      Reflect.apply(mod.call, undefined, args),
    ),
} satisfies Command

export default installSlackApp
