import { getCompanion } from './companion.js'
import { getGlobalConfig } from '../utils/config.js'
import type { Message } from '../types/message.js'

let lastFireTime = 0
const DEBOUNCE_MS = 10_000

const REACTION_KEYWORDS: Array<[RegExp, string]> = [
  [/error|fail|crash|bug/i, '(×_×)'],
  [/success|done|pass|fixed|works/i, '(★‿★)'],
  [/test/i, '(°_°)'],
  [/refactor|clean/i, '(~‿~)'],
  [/deploy|ship|push/i, '\\(◎o◎)/'],
  [/todo|task/i, '(•_•)'],
]

const DEFAULT_REACTIONS = ['(·‿·)', '(◉‿◉)', '(^‿^)', '(°‿°)']

export async function fireCompanionObserver(
  messages: Message[],
  onReaction: (reaction: string) => void,
): Promise<void> {
  const now = Date.now()
  if (now - lastFireTime < DEBOUNCE_MS) return
  lastFireTime = now

  const companion = getCompanion()
  if (!companion) return

  const config = getGlobalConfig()
  if (config.companionMuted) return

  // Look at the last assistant message for keyword matching
  const lastAssistant = [...messages]
    .reverse()
    .find(m => m.type === 'assistant')
  if (!lastAssistant || lastAssistant.type !== 'assistant') return

  const text = lastAssistant.message.content
    .map(block => ('text' in block ? block.text : ''))
    .join(' ')

  for (const [pattern, reaction] of REACTION_KEYWORDS) {
    if (pattern.test(text)) {
      onReaction(reaction)
      return
    }
  }

  // Occasional random idle reaction
  if (Math.random() < 0.15) {
    const reaction =
      DEFAULT_REACTIONS[Math.floor(Math.random() * DEFAULT_REACTIONS.length)]!
    onReaction(reaction)
  }
}
