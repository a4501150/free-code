type IdleReturnAction = 'continue' | 'clear' | 'dismiss' | 'never'

type Props = {
  idleMinutes: number
  currentContextTokens: number
  onDone: (action: IdleReturnAction) => void
}

function formatIdleDuration(minutes: number): string {
  if (minutes < 1) {
    return '< 1m'
  }
  if (minutes < 60) {
    return `${Math.floor(minutes)}m`
  }
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = Math.floor(minutes % 60)
  if (remainingMinutes === 0) {
    return `${hours}h`
  }
  return `${hours}h ${remainingMinutes}m`
}
