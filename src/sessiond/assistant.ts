import { mkdir } from 'fs/promises'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { markAssistantForced } from '../assistant/index.js'
import { forceCoordinatorModeFromCli } from '../coordinator/coordinatorModeGate.js'
import type { SessionRegistry } from './registry.js'
import type { SessionDefaults } from './registry.js'

/**
 * The serve-hosted assistant session — the machine's one assistant.
 *
 * Ported from the gateway bootstrap: same opt-out (`assistant.enabled:
 * false`), same workspace, same resume pointer so the chat survives
 * restarts, same starting/live/gone lifecycle. What changed is the body: it
 * is a HostedSession in the serve process, not a spawned headless child.
 * The `--assistant`/`--coordinator` flags had no in-process equivalent, so
 * the bootstrap calls their latches directly — process-global today, which
 * is honest for one assistant per machine (one serve per machine, enforced
 * by the daemon pidfile) but means a second hosted session in this process
 * also sees assistant mode. A per-scope persona latch is the fix when that
 * ever matters.
 */

/** The assistant's own workspace, so it is not tied to any one project. */
export function assistantWorkspaceDir(): string {
  return join(getClaudeConfigHomeDir(), 'webui', 'assistant')
}

function resumeFilePath(): string {
  return join(getClaudeConfigHomeDir(), 'webui', 'assistant-session.json')
}

async function readResumeId(): Promise<string | undefined> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(resumeFilePath(), 'utf-8'),
    )
    const id = (parsed as { sessionId?: unknown })?.sessionId
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

/** Called on service shutdown, so the next boot resumes the same chat. */
export async function writeAssistantResumeId(sessionId: string): Promise<void> {
  try {
    await mkdir(join(getClaudeConfigHomeDir(), 'webui'), {
      recursive: true,
      mode: 0o700,
    })
    await writeFile(
      resumeFilePath(),
      JSON.stringify({ sessionId, writtenAt: Date.now() }),
      'utf-8',
    )
  } catch {
    // Losing the resume pointer costs one chat history, not the assistant.
  }
}

/**
 * Starts the assistant session unless the user opted out
 * (`assistant.enabled: false`). Never throws: a serve without an assistant
 * still serves every other session.
 *
 * The recorded ID can drift (the assistant `/resume`s or `/clear`s itself);
 * a stale ID fails the resume, and the fallback starts a fresh chat that
 * overwrites the pointer on the next shutdown.
 */
export async function bootstrapAssistantSession(
  registry: SessionRegistry,
  defaults?: SessionDefaults,
): Promise<{ sessionId: string } | null> {
  const assistant = getInitialSettings().assistant
  if (assistant?.enabled === false) return null

  const workspace = assistantWorkspaceDir()
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  // The assistant is a coordinator by default — it orchestrates its own
  // workers and messages spawned sessions (opt out with assistant.
  // coordinator: false).
  markAssistantForced()
  if (assistant?.coordinator !== false) {
    forceCoordinatorModeFromCli()
  }

  const resumeSessionId = await readResumeId()
  if (resumeSessionId) {
    try {
      const entry = await registry.resume({
        sessionId: resumeSessionId,
        cwd: workspace,
        role: 'assistant',
        defaults,
      })
      return { sessionId: entry.sessionId }
    } catch {
      // Missing session, corrupt transcript — fall through to a fresh chat
      // rather than leaving the main chat missing.
    }
  }
  try {
    const entry = await registry.create({
      cwd: workspace,
      role: 'assistant',
      defaults,
    })
    return { sessionId: entry.sessionId }
  } catch {
    return null
  }
}
