import { describe, expect, test } from 'bun:test'
import { getAllBaseTools } from '../../src/tools.js'
import { getSimplePrompt as getBashToolPrompt } from '../../src/tools/BashTool/prompt.js'
import { getEditToolDescription } from '../../src/tools/FileEditTool/prompt.js'
import { getWriteToolDescription } from '../../src/tools/FileWriteTool/prompt.js'
import { DESCRIPTION as BACKGROUND_TASK_LIST_DESCRIPTION } from '../../src/tools/BackgroundTaskListTool/constants.js'
import { getPrompt as getAgentToolPrompt } from '../../src/tools/AgentTool/prompt.js'
import { EXIT_PLAN_MODE_TOOL_PROMPT } from '../../src/tools/ExitPlanModeTool/prompt.js'
import { getEnterPlanModeToolPrompt } from '../../src/tools/EnterPlanModeTool/prompt.js'
import { ASK_USER_QUESTION_TOOL_PROMPT } from '../../src/tools/AskUserQuestionTool/prompt.js'

// Names that have existed in some build or under some name, plus the ones
// prose cross-references most often. A name here that no longer resolves in
// the registry under test means the prompt is teaching a phantom tool — the
// model then hallucinates the call from muscle memory. Renaming a tool means
// adding the old name to this list so stale prose gets caught.
const WATCHLIST = [
  // current cross-referenced names
  'Agent',
  'AskUserQuestion',
  'Bash',
  'BackgroundTaskList',
  'BackgroundTaskOutput',
  'BackgroundTaskStop',
  'CronCreate',
  'Edit',
  'EnterPlanMode',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'Read',
  'SendMessage',
  'Skill',
  'TaskList',
  'WebFetch',
  'WebSearch',
  'Write',
  // historical names that must never resurface un-gated
  'BashOutput',
  'KillShell',
  'NotebookEdit',
  'NotebookRead',
  'Task',
  'TaskOutput',
  'TaskStop',
  'TodoWrite',
  'Tmux',
]

function toolMentions(text: string): string[] {
  return WATCHLIST.filter(name => new RegExp(`\\b${name}\\b`).test(text))
}

describe('tool prompt tool-name drift', () => {
  test('prompt cross-references resolve to tools registered under this feature set', async () => {
    const registered = new Set<string>()
    for (const tool of getAllBaseTools()) {
      registered.add(tool.name)
      for (const alias of tool.aliases ?? []) registered.add(alias)
    }

    const samples: Record<string, string> = {
      bash: getBashToolPrompt(),
      edit: getEditToolDescription(),
      write: getWriteToolDescription(),
      backgroundTaskList: BACKGROUND_TASK_LIST_DESCRIPTION,
      agent: await getAgentToolPrompt([]),
      exitPlanMode: EXIT_PLAN_MODE_TOOL_PROMPT,
      enterPlanMode: getEnterPlanModeToolPrompt(),
      askUserQuestion: ASK_USER_QUESTION_TOOL_PROMPT,
    }

    const offenders: string[] = []
    for (const [sample, text] of Object.entries(samples)) {
      for (const name of toolMentions(text)) {
        if (!registered.has(name)) {
          offenders.push(
            `${sample} prompt mentions unregistered tool "${name}"`,
          )
        }
      }
    }
    expect(offenders).toEqual([])
  })

  test('Edit/Write descriptions drop Grep when dedicated search tools are stripped', () => {
    // shouldPreferBashForSearch() removes Glob/Grep from getAllBaseTools();
    // the descriptions must not teach the phantom Grep in that build.
    const registered = new Set(getAllBaseTools().map(tool => tool.name))
    if (!registered.has('Grep')) {
      expect(getEditToolDescription()).not.toContain('Grep')
      expect(getWriteToolDescription()).not.toContain('Grep')
    }
  })
})
