let _roundRobinIndex = 0

export function getNextRoundRobinIndex(totalTips: number): number {
  if (totalTips <= 0) return 0
  const idx = _roundRobinIndex % totalTips
  _roundRobinIndex = idx + 1
  return idx
}
