import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { AskUserQuestionTool } from '../../src/tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { inputSchema as agentInputSchema } from '../../src/tools/AgentTool/AgentTool.js'
import { stripStrictNullInputs } from '../../src/utils/stripStrictNullInputs.js'

const repoRoot = process.cwd()

function readSource(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8')
}

/** The full pre-validation pipeline from toolExecution: strip, then parse. */
function pipelineParse(raw: Record<string, unknown>): {
  ok: boolean
  data?: Record<string, unknown>
} {
  const stripped = stripStrictNullInputs(
    agentInputSchema as unknown,
    raw,
  ) as Record<string, unknown>
  const parsed = (
    agentInputSchema as unknown as {
      safeParse: (v: unknown) => {
        success: boolean
        data?: Record<string, unknown>
      }
    }
  ).safeParse(stripped)
  return { ok: parsed.success, data: parsed.data }
}

const baseAgentInput = {
  prompt: 'do a thing',
  description: 'testing',
  subagent_type: 'general-purpose',
}

describe('Agent isolation parameter accepts empty fills', () => {
  test('"none" parses and reaches call() as an explicit opt-out', () => {
    const result = pipelineParse({ ...baseAgentInput, isolation: 'none' })
    expect(result.ok).toBe(true)
    expect(result.data?.isolation).toBe('none')
  })

  test('null fill strips to omitted', () => {
    const result = pipelineParse({ ...baseAgentInput, isolation: null })
    expect(result.ok).toBe(true)
    expect(result.data?.isolation).toBeUndefined()
    expect('isolation' in (result.data ?? {})).toBe(false)
  })

  test('empty-string fill strips to omitted', () => {
    const result = pipelineParse({ ...baseAgentInput, isolation: '' })
    expect(result.ok).toBe(true)
    expect(result.data?.isolation).toBeUndefined()
  })

  test('"worktree" still parses', () => {
    const result = pipelineParse({ ...baseAgentInput, isolation: 'worktree' })
    expect(result.ok).toBe(true)
    expect(result.data?.isolation).toBe('worktree')
  })

  test('an unknown mode still fails validation (typo protection kept)', () => {
    const result = pipelineParse({ ...baseAgentInput, isolation: 'sandbox' })
    expect(result.ok).toBe(false)
  })

  test('call() normalizes "none" before the agent-definition merge', () => {
    const source = readSource('src/tools/AgentTool/AgentTool.tsx')
    expect(source).toMatch(
      /isolation === 'none'\s*\?\s*undefined\s*:\s*\(?\s*isolation\s*\?\?\s*selectedAgent\.isolation\s*\)?/,
    )
  })

  test('frontmatter loader treats isolation: none as no-isolation', () => {
    const loader = readSource('src/tools/AgentTool/loadAgentsDir.ts')
    expect(loader).toContain("isolationRaw !== 'none'")
  })
})

describe('AskUserQuestion tolerates null fills inside question items', () => {
  const question = {
    question: 'Pick one?',
    header: 'Pick',
    options: [
      { label: 'Yes', description: 'yes' },
      { label: 'No', description: 'no' },
    ],
  }

  function parseQuestions(rawQuestions: unknown[]) {
    const raw = { questions: rawQuestions }
    const stripped = stripStrictNullInputs(
      AskUserQuestionTool.inputSchema as unknown,
      raw,
    )
    return AskUserQuestionTool.inputSchema.safeParse(stripped)
  }

  test('multiSelect: null inside an item no longer voids the call', () => {
    const parsed = parseQuestions([{ ...question, multiSelect: null }])
    expect(parsed.success).toBe(true)
    const item = parsed.success
      ? (parsed.data.questions[0] as Record<string, unknown>)
      : undefined
    expect(item?.multiSelect).toBeUndefined()
  })

  test('multiSelect: true still survives', () => {
    const parsed = parseQuestions([{ ...question, multiSelect: true }])
    expect(parsed.success).toBe(true)
    const item = parsed.success
      ? (parsed.data.questions[0] as Record<string, unknown>)
      : undefined
    expect(item?.multiSelect).toBe(true)
  })

  test('preview: null inside an option strips to omitted', () => {
    const parsed = parseQuestions([
      {
        ...question,
        options: [
          { label: 'Yes', description: 'yes', preview: null },
          { label: 'No', description: 'no' },
        ],
      },
    ])
    expect(parsed.success).toBe(true)
    const item = parsed.success
      ? (parsed.data.questions[0] as { options: Record<string, unknown>[] })
      : undefined
    expect('preview' in item!.options[0]).toBe(false)
  })
})
