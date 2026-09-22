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

  test('plan-mode pair keeps the plan-visibility contract in ExitPlanMode', () => {
    const enter = readSource('src/tools/EnterPlanModeTool/prompt.ts')
    const exit = readSource('src/tools/ExitPlanModeTool/prompt.ts')

    expect(exit).toContain('cannot see the plan until this tool is called')
    expect(enter).toContain('REQUIRES user approval')
    expect(enter).not.toContain('What Happens in Plan Mode')
  })

  test('optional and destructive tool guidance matches runtime contracts', () => {
    const read = readSource('src/tools/FileReadTool/prompt.ts')
    const exitWorktree = readSource('src/tools/ExitWorktreeTool/prompt.ts')

    expect(read).toContain('provide only \\`file_path\\` to read the full file')
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
    const create = readSource('src/tools/TaskCreateTool/prompt.ts')
    const update = readSource('src/tools/TaskUpdateTool/prompt.ts')

    expect(edit).toContain('read that target file')
    expect(output).toContain(
      'Retrieve output from a running or completed background task',
    )
    expect(output).not.toContain('[Deprecated]')
    expect(create).toContain('as soon as you finish it')
    expect(update).toContain('only when the task is fully accomplished')
    expect(update).not.toContain('Mark tasks as resolved')
  })
})

describe('conditional mode prompt alignment', () => {
  test('main prompt keeps generic tool routing and verifier exposure gates', () => {
    const source = readSource('src/constants/prompts.ts')
    const attachments = readSource('src/utils/attachments.ts')

    expect(source).toContain(
      'Prefer a dedicated file/search tool over a shell command',
    )
    expect(source).not.toContain('enabledTools.has(FILE_READ_TOOL_NAME)')
    expect(source).not.toContain('enabledTools.has(FILE_EDIT_TOOL_NAME)')
    expect(source).not.toContain('enabledTools.has(FILE_WRITE_TOOL_NAME)')
    expect(source).not.toContain('For multi-step work, use')
    // Verifier guidance rides the session_guidance attachment now; no
    // per-turn-recomputed section may remain in the system prompt.
    expect(attachments).toContain('hasPlanVerifier')
    expect(source).not.toContain('DANGEROUS_uncachedSystemPromptSection')
    expect(source).not.toContain('# Session-specific guidance')
  })

  test('Brief mode explicitly owns visible user replies', () => {
    const source = readSource('src/tools/BriefTool/prompt.ts')

    expect(source).toContain('override generic guidance')
    expect(source).toContain('ack first in one line')
    expect(source).toContain('reply they actually read comes through')
  })

  test('assistant autonomy guidance rides the assistant_mode attachment, not the prompt', () => {
    const assistantBlock = readSource('src/assistant/index.ts')
    const constants = readSource('src/constants/prompts.ts')
    const startup = readSource('src/main.tsx')

    // Event-driven policy: wake on events, act without blocking on
    // confirmation, never a polling/tick loop.
    expect(assistantBlock).toContain('wakes on events')
    expect(assistantBlock).toContain('rather than asking for confirmation')
    expect(assistantBlock).toContain('there is nothing to poll')
    expect(constants).not.toContain('getProactiveSection')
    expect(constants).not.toContain('wait for direction')
    expect(startup).not.toContain('maybeActivateProactive')
    expect(startup).not.toContain('Proactive Mode')
  })

  test('headless coordinator prompt follows the live coordinator gate', () => {
    const source = readSource('src/QueryEngine.ts')

    expect(source).toContain('coordinatorModeModule.isCoordinatorMode()')
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

  test('Agent tool prompt owns its field-specific guidance and Sleep is gone', () => {
    const mainPrompt = readSource('src/constants/prompts.ts')
    const agentPrompt = readSource('src/tools/AgentTool/prompt.ts')
    const agentSchema = readSource('src/tools/AgentTool/AgentTool.tsx')

    expect(mainPrompt).not.toContain('SLEEP_TOOL_NAME')
    expect(mainPrompt).not.toContain('/<skill-name> is shorthand')
    expect(mainPrompt).not.toContain('For broader codebase exploration')
    expect(agentPrompt).toContain(
      'Avoid duplicating work that active agents are already doing',
    )
    expect(agentSchema).toContain('NOT a parallelism mechanism')
    expect(agentSchema).toContain(
      'its final report is delivered as a system notification',
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
