type TriggerPosition = { word: string; start: number; end: number }

/**
 * Find "/buddy" command positions in text (for UI rainbow highlighting).
 * Mirrors findThinkingTriggerPositions in thinking.ts, but matches the
 * literal slash command only — start-of-text or after whitespace.
 */
export function findBuddyTriggerPositions(text: string): TriggerPosition[] {
  const positions: TriggerPosition[] = []
  const matches = text.matchAll(/(^|\s)(\/buddy)\b/gi)

  for (const match of matches) {
    if (match.index === undefined) continue
    const start = match.index + match[1]!.length
    positions.push({
      word: match[2]!,
      start,
      end: start + match[2]!.length,
    })
  }

  return positions
}
