/**
 * Copy command - minimal metadata only.
 * Implementation is lazy-loaded from copy.tsx to reduce startup time.
 */
import type { Command } from '../../commands.js'

const copy = {
  type: 'local-jsx',
  name: 'copy',
  description:
    "Copy Claude's last response to clipboard (or /copy N for the Nth-latest)",
  call: (...args) =>
    import('./copy.js').then(mod => Reflect.apply(mod.call, undefined, args)),
} satisfies Command

export default copy
