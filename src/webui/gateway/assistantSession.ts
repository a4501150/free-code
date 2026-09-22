import { mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import type { ChildSession, ChildSessions } from './childSessions.js'

/**
 * The gateway-hosted assistant session — the machine's one assistant.
 *
 * The gateway always keeps one long-lived assistant session alive across
 * restarts (opt out with `assistant.enabled: false`), and the browser presents
 * it as the main chat (`role: 'assistant'` on its session-list row). It is an
 * ordinary gateway child — headless, attachable, permission-gated — spawned
 * with `--assistant` so it carries the assistant persona. It is event-driven:
 * browser/terminal submits, scheduled cron tasks, and `assistant.notify`
 * control requests wake it; there is no polling loop.
 *
 * One gateway exists per machine (the daemon pidfile enforces it) and this
 * module keeps exactly one child, which is what makes the assistant
 * one-per-machine. The TUI joins this session; it cannot initialize one.
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

/** Called on gateway shutdown, so the next boot resumes the same chat. */
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
 * (`assistant.enabled: false`). Never throws: a gateway without an assistant
 * still serves every other session.
 *
 * The recorded ID can drift (the assistant `/resume`s or `/clear`s itself); a
 * stale ID fails the resume gate, and the fallback starts a fresh chat that
 * overwrites the pointer on the next shutdown.
 */
export async function bootstrapAssistantSession(
  children: ChildSessions,
): Promise<ChildSession | null> {
  const assistant = getInitialSettings().assistant
  if (assistant?.enabled === false) return null

  const workspace = assistantWorkspaceDir()
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  const extraArgs = ['--assistant']

  const resumeSessionId = await readResumeId()
  if (resumeSessionId) {
    try {
      return await children.start({
        cwd: workspace,
        resumeSessionId,
        extraArgs,
      })
    } catch {
      // Missing session, holder conflict, crashed child — fall through to a
      // fresh chat rather than leaving the main chat missing.
    }
  }
  try {
    return await children.start({ cwd: workspace, extraArgs })
  } catch {
    return null
  }
}
