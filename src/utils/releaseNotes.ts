import axios from 'axios'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, join } from 'path'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { getClaudeConfigHomeDir } from './envUtils.js'
import { toError } from './errors.js'
import { logError } from './log.js'
import { isEssentialTrafficOnly } from './privacyLevel.js'

const MAX_WHATS_NEW_ITEMS = 5

interface WhatsNewItem {
  title: string
  url: string
}

interface WhatsNewCache {
  type: 'releases' | 'commits'
  items: WhatsNewItem[]
}

export const REPO_URL = MACRO.GITHUB_REPO
  ? `https://github.com/${MACRO.GITHUB_REPO}`
  : ''

function getCachePath(): string {
  return join(getClaudeConfigHomeDir(), 'cache', 'whats-new.json')
}

let memoryCache: WhatsNewCache | null = null

/** @internal exported for tests */
export function _resetWhatsNewCacheForTesting(): void {
  memoryCache = null
}

async function fetchGitHubReleases(
  repo: string,
): Promise<WhatsNewCache | null> {
  const response = await axios.get(
    `https://api.github.com/repos/${repo}/releases?per_page=${MAX_WHATS_NEW_ITEMS}`,
    { headers: { Accept: 'application/vnd.github.v3+json' } },
  )
  if (
    response.status === 200 &&
    Array.isArray(response.data) &&
    response.data.length > 0
  ) {
    return {
      type: 'releases',
      items: response.data.map(
        (r: { name?: string; tag_name: string; html_url: string }) => ({
          title: r.name || r.tag_name,
          url: r.html_url,
        }),
      ),
    }
  }
  return null
}

async function fetchGitHubCommits(repo: string): Promise<WhatsNewCache | null> {
  const response = await axios.get(
    `https://api.github.com/repos/${repo}/commits?per_page=${MAX_WHATS_NEW_ITEMS}`,
    { headers: { Accept: 'application/vnd.github.v3+json' } },
  )
  if (response.status === 200 && Array.isArray(response.data)) {
    return {
      type: 'commits',
      items: response.data.map(
        (c: {
          sha: string
          commit: { message: string }
          html_url: string
        }) => ({
          title: `${c.sha.slice(0, 7)} ${c.commit.message.split('\n')[0]}`,
          url: c.html_url,
        }),
      ),
    }
  }
  return null
}

export async function fetchAndStoreWhatsNew(): Promise<void> {
  if (getIsNonInteractiveSession()) return
  if (isEssentialTrafficOnly()) return

  const repo = MACRO.GITHUB_REPO
  if (!repo) return

  let data = await fetchGitHubReleases(repo)
  if (!data) {
    data = await fetchGitHubCommits(repo)
  }
  if (!data) return

  const serialized = JSON.stringify(data)
  if (memoryCache && JSON.stringify(memoryCache) === serialized) return

  const cachePath = getCachePath()
  await mkdir(dirname(cachePath), { recursive: true })
  await writeFile(cachePath, serialized, { encoding: 'utf-8' })
  memoryCache = data
}

export async function getStoredWhatsNew(): Promise<WhatsNewCache | null> {
  if (memoryCache !== null) return memoryCache
  const cachePath = getCachePath()
  try {
    const content = await readFile(cachePath, 'utf-8')
    memoryCache = JSON.parse(content) as WhatsNewCache
    return memoryCache
  } catch {
    return null
  }
}

function getWhatsNewFromMemory(): WhatsNewCache | null {
  return memoryCache
}

function parseBuildTimeChangelog(): string[] {
  const changelog = MACRO.VERSION_CHANGELOG
  if (!changelog) return []
  return changelog.split('\n').filter(Boolean).slice(0, MAX_WHATS_NEW_ITEMS)
}

export function getWhatsNewItems(maxItems: number): string[] {
  const cached = getWhatsNewFromMemory()
  if (cached && cached.items.length > 0) {
    return cached.items.map(i => i.title).slice(0, maxItems)
  }
  return parseBuildTimeChangelog().slice(0, maxItems)
}

export function getWhatsNewType(): 'releases' | 'commits' | 'build' {
  const cached = getWhatsNewFromMemory()
  if (cached) return cached.type
  return 'build'
}

export function getWhatsNewItemsFull(maxItems: number): WhatsNewItem[] {
  const cached = getWhatsNewFromMemory()
  if (cached && cached.items.length > 0) {
    return cached.items.slice(0, maxItems)
  }
  return parseBuildTimeChangelog()
    .slice(0, maxItems)
    .map(title => ({ title, url: '' }))
}

// --- Compat layer: keep the same signatures expected by LogoV2, setup.ts, etc. ---

export async function checkForReleaseNotes(
  _lastSeenVersion: string | null | undefined,
  _currentVersion: string = MACRO.VERSION,
): Promise<{ hasReleaseNotes: boolean; releaseNotes: string[] }> {
  await getStoredWhatsNew()
  fetchAndStoreWhatsNew().catch(error => logError(toError(error)))

  const releaseNotes = getWhatsNewItems(MAX_WHATS_NEW_ITEMS)
  return {
    hasReleaseNotes: releaseNotes.length > 0,
    releaseNotes,
  }
}

export function checkForReleaseNotesSync(
  _lastSeenVersion: string | null | undefined,
  _currentVersion: string = MACRO.VERSION,
): { hasReleaseNotes: boolean; releaseNotes: string[] } {
  const releaseNotes = getWhatsNewItems(MAX_WHATS_NEW_ITEMS)
  return {
    hasReleaseNotes: releaseNotes.length > 0,
    releaseNotes,
  }
}
