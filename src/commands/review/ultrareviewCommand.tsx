import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async (onDone) => {
  onDone(
    'Ultrareview requires Claude Code on the web infrastructure which is not available in this build.',
    { display: 'system' },
  )
  return null
}
