import { execa } from 'execa'
import { readFile } from 'fs/promises'
import { homedir } from 'os'
import { dirname, resolve } from 'path'
import { errorMessage, isENOENT } from '../utils/errors.js'

/**
 * `claude up`
 *
 * Walks up from CWD looking for a CLAUDE.md. When one is found, extracts the
 * `# claude up` (or `## claude up`) markdown section and executes every fenced
 * bash/sh/shell (or unlabeled) code block in sequence via `bash -c`.
 *
 * The first non-zero exit code aborts the run and propagates.
 */
export async function up(): Promise<void> {
  const found = await findClaudeMd(resolve(process.cwd()))
  if (!found) {
    // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
    console.error('No CLAUDE.md found walking up from the current directory.')
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  let content: string
  try {
    content = await readFile(found, { encoding: 'utf-8' })
  } catch (e) {
    // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
    console.error(`Failed to read ${found}: ${errorMessage(e)}`)
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  const blocks = extractClaudeUpBlocks(content)
  if (blocks.length === 0) {
    // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
    console.error(
      `${found} has no "# claude up" section with shell code blocks.`,
    )
    // eslint-disable-next-line custom-rules/no-process-exit
    process.exit(1)
  }

  const cwd = dirname(found)
  // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
  console.log(`Running ${blocks.length} block(s) from ${found}`)

  for (const block of blocks) {
    try {
      const result = await execa('bash', ['-c', block], {
        stdio: 'inherit',
        cwd,
        reject: false,
      })
      if (result.exitCode !== 0) {
        // eslint-disable-next-line custom-rules/no-process-exit
        process.exit(result.exitCode ?? 1)
      }
    } catch (e) {
      // biome-ignore lint/suspicious/noConsole:: user-facing CLI output
      console.error(`Failed to execute block: ${errorMessage(e)}`)
      // eslint-disable-next-line custom-rules/no-process-exit
      process.exit(1)
    }
  }
}

async function findClaudeMd(startDir: string): Promise<string | null> {
  const home = homedir()
  let dir = startDir
  // Stop at $HOME or filesystem root. Walk inclusive of both.
  while (true) {
    const candidate = resolve(dir, 'CLAUDE.md')
    try {
      await readFile(candidate)
      return candidate
    } catch (e) {
      if (!isENOENT(e)) throw e
    }
    if (dir === home) break
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * Extracts shell-runnable code blocks from the "# claude up" markdown section.
 * Accepts both H1 (`# claude up`) and H2 (`## claude up`). Collects fenced
 * blocks tagged bash/sh/shell or untagged up to the next heading of equal-or-lesser depth.
 */
export function extractClaudeUpBlocks(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/)

  // Find the heading line.
  let headingIdx = -1
  let headingLevel = 0
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^(#{1,2})\s+claude\s+up\s*$/i)
    if (m) {
      headingIdx = i
      headingLevel = m[1]!.length
      break
    }
  }
  if (headingIdx === -1) return []

  // Find end of section: next heading of depth <= headingLevel.
  let endIdx = lines.length
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const m = lines[i]!.match(/^(#{1,6})\s+/)
    if (m && m[1]!.length <= headingLevel) {
      endIdx = i
      break
    }
  }

  const blocks: string[] = []
  let i = headingIdx + 1
  while (i < endIdx) {
    const line = lines[i]!
    const fenceMatch = line.match(/^```(bash|sh|shell)?\s*$/)
    if (!fenceMatch) {
      i++
      continue
    }
    // Start of a fenced block — collect until closing ```.
    const body: string[] = []
    i++
    while (i < endIdx) {
      const inner = lines[i]!
      if (inner.match(/^```\s*$/)) break
      body.push(inner)
      i++
    }
    i++ // consume closing fence
    const joined = body.join('\n').trim()
    if (joined) {
      blocks.push(joined)
    }
  }
  return blocks
}
