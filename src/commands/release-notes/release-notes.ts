import type { LocalCommandResult } from '../../types/command.js'
import {
  REPO_URL,
  fetchAndStoreWhatsNew,
  getStoredWhatsNew,
  getWhatsNewItemsFull,
  getWhatsNewType,
} from '../../utils/releaseNotes.js'

export async function call(): Promise<LocalCommandResult> {
  try {
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(rej => rej(new Error('Timeout')), 3000, reject)
    })
    await Promise.race([fetchAndStoreWhatsNew(), timeoutPromise])
    await getStoredWhatsNew()
  } catch {
    // Fetch failed or timed out — use cached data
  }

  const items = getWhatsNewItemsFull(10)
  if (items.length === 0) {
    const url = REPO_URL ? `${REPO_URL}/commits/main` : 'the repository'
    return { type: 'text', value: `No cached updates. See ${url}` }
  }

  const type = getWhatsNewType()
  const header =
    type === 'releases' ? 'Recent releases:' : 'Recent commits:'

  const lines = items
    .map(item => (item.url ? `· ${item.title}\n  ${item.url}` : `· ${item.title}`))
    .join('\n')

  return { type: 'text', value: `${header}\n${lines}` }
}
