import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { formatSkillNamesOnly } from '../../src/tools/SkillTool/prompt.js'

const repoRoot = process.cwd()

function readSource(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8')
}

describe('tool prompt contracts', () => {
  test('Skill permits an acknowledgement but requires invocation before work', () => {
    const source = readSource('src/tools/SkillTool/prompt.ts')

    expect(source).toContain('after any brief acknowledgment')
    expect(source).toContain('BEFORE performing substantive work')
    expect(source).toContain(
      'exact skill name from the available skills listing',
    )
    expect(source).toContain('Do not infer skill names from examples')
  })

  test('EnterPlanMode selects search instructions from available search mode', () => {
    const source = readSource('src/tools/EnterPlanModeTool/prompt.ts')

    expect(source).toContain('shouldPreferBashForSearch()')
    expect(source).toContain("? '`find`, `grep`, and Read'")
    expect(source).toContain(": 'Glob, Grep, and Read'")
  })

  test('optional and destructive tool guidance matches runtime contracts', () => {
    const read = readSource('src/tools/FileReadTool/prompt.ts')
    const search = readSource('src/tools/WebSearchTool/WebSearchTool.ts')
    const exitWorktree = readSource('src/tools/ExitWorktreeTool/prompt.ts')

    expect(read).toContain('provide only \\`file_path\\` to read the full file')
    expect(search).toContain('Mutually exclusive with blocked_domains')
    expect(search).toContain('Mutually exclusive with allowed_domains')
    expect(exitWorktree).toContain(
      'after the user explicitly confirms destructive removal',
    )
  })

  test('Agent rejects cwd with effective worktree isolation before creation', () => {
    const source = readSource('src/tools/AgentTool/AgentTool.tsx')
    const guard = source.indexOf(
      'cwd cannot be used together with worktree isolation',
    )
    const create = source.indexOf('await createAgentWorktree(slug)')

    expect(guard).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(guard)
  })

  test('Edit requires reading the existing target and task wording is supported', () => {
    const edit = readSource('src/tools/FileEditTool/prompt.ts')
    const output = readSource('src/tools/TaskOutputTool/TaskOutputTool.tsx')
    const update = readSource('src/tools/TaskUpdateTool/prompt.ts')

    expect(edit).toContain('read that target file')
    expect(output).toContain(
      'Retrieve output from a running or completed background task',
    )
    expect(output).not.toContain('[Deprecated]')
    expect(update).toContain('Mark tasks as completed')
    expect(update).not.toContain('Mark tasks as resolved')
  })
})

describe('conditional mode prompt alignment', () => {
  test('main prompt keeps generic tool routing and verifier exposure gates', () => {
    const source = readSource('src/constants/prompts.ts')

    expect(source).toContain('const hasDedicatedTools')
    expect(source).toContain(
      'When a relevant dedicated tool is available, prefer it over shell commands',
    )
    expect(source).not.toContain('enabledTools.has(FILE_READ_TOOL_NAME)')
    expect(source).not.toContain('enabledTools.has(FILE_EDIT_TOOL_NAME)')
    expect(source).not.toContain('enabledTools.has(FILE_WRITE_TOOL_NAME)')
    expect(source).not.toContain('For multi-step work, use')
    expect(source).toContain('hasPlanVerifier')
    expect(source).toContain('DANGEROUS_uncachedSystemPromptSection')
    expect(source).toContain('Tool availability can change between turns')
  })

  test('Brief mode explicitly owns visible user replies', () => {
    const source = readSource('src/tools/BriefTool/prompt.ts')

    expect(source).toContain('override generic guidance')
    expect(source).toContain('ack first in one line')
    expect(source).toContain('reply they actually read comes through')
  })

  test('proactive entry points require direction before autonomous work', () => {
    const constants = readSource('src/constants/prompts.ts')
    const startup = readSource('src/main.tsx')
    const command = readSource('src/commands/proactive.ts')

    expect(constants).toContain('wait for direction')
    expect(startup).toContain('do not begin work until they provide direction')
    expect(command).toContain('do not begin work until they provide direction')
    expect(startup).not.toContain(
      'Take initiative — explore, act, and make progress without waiting for instructions.',
    )
  })

  test('headless coordinator prompt follows the live coordinator gate', () => {
    const source = readSource('src/QueryEngine.ts')

    expect(source).toContain('coordinatorModeModule?.isCoordinatorMode()')
    expect(source).toContain(
      'coordinatorModeModule.getCoordinatorSystemPrompt()',
    )
    expect(source).toContain('customPrompt === undefined')
  })

  test('universal platform policy has one owner', () => {
    const invariant = readSource('src/utils/agenticSystemPrompt.ts')
    const bashPrompt = readSource('src/tools/BashTool/prompt.ts')
    const editPrompt = readSource('src/tools/FileEditTool/prompt.ts')
    const writePrompt = readSource('src/tools/FileWriteTool/prompt.ts')
    const verificationPrompt = readSource(
      'src/tools/AgentTool/built-in/verificationAgent.ts',
    )
    const mainPrompt = readSource('src/constants/prompts.ts')
    const forkedAgent = readSource('src/utils/forkedAgent.ts')

    expect(invariant).toContain('including in file contents')
    expect(invariant).toContain('platform-provided temporary directory')
    expect(invariant).toContain('Never hardcode \\`/tmp\\`')
    expect(editPrompt).not.toContain('Only use emojis')
    expect(writePrompt).not.toContain('Only use emojis')
    expect(bashPrompt).not.toContain(
      'scratchpad directory provided in the system prompt',
    )
    expect(verificationPrompt).toContain('an allowed temporary location')
    expect(verificationPrompt).not.toContain('/tmp or $TMPDIR')
    expect(mainPrompt).toContain('\\`${scratchpadDir}\\`')
    expect(mainPrompt).not.toContain('sandbox-specific temporary-file guidance')
    expect(mainPrompt).not.toContain('Only use emojis')
    expect(forkedAgent).toContain(
      'systemPrompt: withAgenticSystemPromptInvariants(systemPrompt)',
    )
  })

  test('Sleep and Agent tool prompts own their field-specific guidance', () => {
    const mainPrompt = readSource('src/constants/prompts.ts')
    const sleepPrompt = readSource('src/tools/SleepTool/prompt.ts')
    const agentPrompt = readSource('src/tools/AgentTool/prompt.ts')
    const agentSchema = readSource('src/tools/AgentTool/AgentTool.tsx')

    expect(mainPrompt).toContain('MUST call ${SLEEP_TOOL_NAME}')
    expect(mainPrompt).not.toContain('Each wake-up costs an API call')
    expect(sleepPrompt).toContain('Each wake-up costs an API call')
    expect(mainPrompt).not.toContain('/<skill-name> is shorthand')
    expect(mainPrompt).not.toContain('For broader codebase exploration')
    expect(agentPrompt).toContain(
      'Avoid duplicating work that active agents are already doing',
    )
    expect(agentSchema).toContain('NOT a parallelism mechanism')
    expect(agentSchema).toContain(
      'Use this instead of sleeping or repeatedly checking on the agent',
    )
  })
})

describe('compact skill discovery refresh', () => {
  test('names-only listing contains invocable names without descriptions', () => {
    expect(
      formatSkillNamesOnly([
        { name: 'review-code' },
        { name: 'suite:publish' },
      ]),
    ).toBe('- review-code\n- suite:publish')
  })

  test('both compact paths restore the names-only skill listing', () => {
    const attachmentSource = readSource('src/utils/attachments.ts')
    const compactSource = readSource('src/services/compact/compact.ts')

    expect(attachmentSource).toContain('getPostCompactSkillListingAttachment')
    expect(attachmentSource).toContain(
      'content: formatSkillNamesOnly(allCommands)',
    )
    expect(
      compactSource.match(/getPostCompactSkillListingAttachment\(context\)/g),
    ).toHaveLength(2)
  })
})
