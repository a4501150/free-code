import type { Command } from '../commands.js'
import type { LocalJSXCommandCall } from '../types/command.js'

export const CCR_TERMS_URL =
  'https://code.claude.com/docs/en/claude-code-on-the-web'

export function buildUltraplanPrompt(blurb: string, seedPlan?: string): string {
  const parts: string[] = []
  if (seedPlan) {
    parts.push('Here is a draft plan to refine:', '', seedPlan, '')
  }
  if (blurb) {
    parts.push(blurb)
  }
  return parts.join('\n')
}

export async function stopUltraplan(
  _taskId: string,
  _sessionId: string,
  _setAppState: (f: (prev: unknown) => unknown) => void,
): Promise<void> {
  // No-op: CCR infrastructure removed
}

export async function launchUltraplan(_opts: {
  blurb: string
  seedPlan?: string
  getAppState: () => unknown
  setAppState: (f: (prev: unknown) => unknown) => void
  signal: AbortSignal
  onSessionReady?: (msg: string) => void
}): Promise<string> {
  return 'ultraplan requires Claude Code on the web infrastructure which is not available in this build.'
}

const call: LocalJSXCommandCall = async onDone => {
  onDone(
    'ultraplan requires Claude Code on the web infrastructure which is not available in this build.',
    { display: 'system' },
  )
  return null
}

export default {
  type: 'local-jsx',
  name: 'ultraplan',
  description: `~10–30 min · Claude Code on the web drafts an advanced plan you can edit and approve. See ${CCR_TERMS_URL}`,
  argumentHint: '<prompt>',
  isEnabled: () => false,
  load: () => Promise.resolve({ call }),
} satisfies Command
