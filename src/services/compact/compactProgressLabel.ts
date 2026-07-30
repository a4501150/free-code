import type { CompactProgressEvent } from '../../Tool.js'

const HOOK_LABELS = {
  pre_compact: 'Running PreCompact hooks',
  post_compact: 'Running PostCompact hooks',
  session_start: 'Running SessionStart hooks',
} as const

/**
 * Spinner verb for a compaction progress event, or null when compaction ended.
 *
 * No trailing ellipsis — the spinner appends one to whatever verb it is given.
 */
export function compactProgressLabel(
  event: CompactProgressEvent,
): string | null {
  switch (event.type) {
    case 'hooks_start':
      return HOOK_LABELS[event.hookType]
    case 'compact_start':
      return 'Compacting conversation'
    case 'compact_end':
      return null
  }
}
