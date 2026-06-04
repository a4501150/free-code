import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { withAgentStoppedStatus } from '../../src/tools/AgentTool/agentToolResult.js'
import { extractTextContent } from '../../src/utils/messages.js'

const repoRoot = process.cwd()

function readSource(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8')
}

describe('withAgentStoppedStatus', () => {
  test('leaves clean completion content unchanged', () => {
    const content = [{ type: 'text' as const, text: 'done' }]

    expect(withAgentStoppedStatus({ content })).toBe(content)
  })

  test('prepends exactly one stopped marker when a reason exists', () => {
    const content = withAgentStoppedStatus({
      content: [{ type: 'text', text: 'partial result' }],
      errorReason: 'invalid_request',
    })
    const text = extractTextContent(content, '\n')

    expect(content).toEqual([
      { type: 'text', text: '<status>stopped: invalid_request</status>' },
      { type: 'text', text: 'partial result' },
    ])
    expect(
      text.match(/<status>stopped: invalid_request<\/status>/g),
    ).toHaveLength(1)
  })

  test('all completion surfaces use the shared formatter', () => {
    const utils = readSource('src/tools/AgentTool/agentToolUtils.ts')
    const agentTool = readSource('src/tools/AgentTool/AgentTool.tsx')
    const taskOutput = readSource('src/tools/TaskOutputTool/TaskOutputTool.tsx')

    expect(utils).toContain('withAgentStoppedStatus(agentResult)')
    expect(agentTool).toContain('withAgentStoppedStatus(agentResult)')
    expect(agentTool).toContain('withAgentStoppedStatus({')
    expect(taskOutput).toContain('withAgentStoppedStatus(agentTask.result)')
  })
})
