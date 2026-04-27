import { describe, expect, test } from 'bun:test'
import { AskUserQuestionTool } from '../../src/tools/AskUserQuestionTool/AskUserQuestionTool.js'
import { toolToAPISchema } from '../../src/utils/api.js'

function findArrayBounds(value: unknown, path = '$'): string[] {
  if (typeof value !== 'object' || value === null) {
    return []
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      findArrayBounds(item, `${path}[${index}]`),
    )
  }

  const node = value as Record<string, unknown>
  const hits: string[] = []
  if (node.type === 'array') {
    if ('minItems' in node) hits.push(`${path}.minItems`)
    if ('maxItems' in node) hits.push(`${path}.maxItems`)
  }

  for (const [key, child] of Object.entries(node)) {
    hits.push(...findArrayBounds(child, `${path}.${key}`))
  }
  return hits
}

describe('toolToAPISchema array bounds', () => {
  test('strips array minItems/maxItems unsupported by Anthropic tool schemas', async () => {
    const schema = await toolToAPISchema(AskUserQuestionTool, {
      getToolPermissionContext: async () => ({}) as never,
      tools: [AskUserQuestionTool],
      agents: [],
    })

    expect(findArrayBounds(schema)).toEqual([])
  })
})
