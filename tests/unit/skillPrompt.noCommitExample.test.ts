import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'

const repoRoot = process.cwd()

function readSource(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8')
}

describe('skill prompts avoid unlisted commit skill examples', () => {
  test('Skill tool prompt requires exact listed skill names', () => {
    const source = readSource('src/tools/SkillTool/prompt.ts')

    expect(source).not.toContain('/commit')
    expect(source).not.toContain('skill: "commit"')
    expect(source).toContain(
      'exact skill name from the available skills listing',
    )
    expect(source).toContain('Do not infer skill names from examples')
  })

  test('coordinator prompt does not cite commit as a skill example', () => {
    const source = readSource('src/coordinator/coordinatorMode.ts')

    expect(source).not.toContain('/commit')
    expect(source).toContain('Delegate only listed skill invocations')
  })

  test('insights prompt does not suggest commit as the custom skill example', () => {
    const source = readSource('src/commands/insights.ts')

    expect(source).not.toContain('.claude/skills/commit/SKILL.md')
    expect(source).not.toContain('.freecode/skills/commit/SKILL.md')
    expect(source).not.toContain('type \\`/commit\\`')
    expect(source).toContain('.freecode/skills/release-checklist/SKILL.md')
  })
})
