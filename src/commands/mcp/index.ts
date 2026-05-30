import type { Command } from '../../commands.js'

const mcp = {
  type: 'local-jsx',
  name: 'mcp',
  description: 'Manage MCP servers',
  immediate: true,
  argumentHint: '[enable|disable [server-name]]',
  call: (...args) =>
    import('./mcp.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default mcp
