import { getInvokedSkillsForAgent } from '../../bootstrap/state.js'
import { getInitialSettings } from '../settings/settings.js'
import type { Message } from '../../types/message.js'
import { count } from '../array.js'
import { createUserMessage, extractTag } from '../messages.js'
import { getUtilityModel } from '../model/model.js'
import { jsonParse } from '../slowOperations.js'
import {
  type ApiQueryHookConfig,
  createApiQueryHook,
} from './apiQueryHookHelper.js'
import { registerPostSamplingHook } from './postSamplingHooks.js'

const TURN_BATCH_SIZE = 5

export type SkillUpdate = {
  section: string
  change: string
  reason: string
}

function formatRecentMessages(messages: Message[]): string {
  return messages
    .filter(m => m.type === 'user' || m.type === 'assistant')
    .map(m => {
      const role = m.type === 'user' ? 'User' : 'Assistant'
      const content = m.message.content
      if (typeof content === 'string')
        return `${role}: ${content.slice(0, 500)}`
      const text = content
        .filter(
          (b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text',
        )
        .map(b => b.text)
        .join('\n')
      return `${role}: ${text.slice(0, 500)}`
    })
    .join('\n\n')
}

function findProjectSkill() {
  const skills = getInvokedSkillsForAgent(null)
  for (const [, info] of skills) {
    if (info.skillPath.startsWith('projectSettings:')) {
      return info
    }
  }
  return undefined
}

function createSkillImprovementHook() {
  let lastAnalyzedCount = 0
  let lastAnalyzedIndex = 0

  const config: ApiQueryHookConfig<SkillUpdate[]> = {
    name: 'skill_improvement',

    async shouldRun(context) {
      if (context.querySource !== 'repl_main_thread') {
        return false
      }

      if (!findProjectSkill()) {
        return false
      }

      // Only run every TURN_BATCH_SIZE user messages
      const userCount = count(context.messages, m => m.type === 'user')
      if (userCount - lastAnalyzedCount < TURN_BATCH_SIZE) {
        return false
      }

      lastAnalyzedCount = userCount
      return true
    },

    buildMessages(context) {
      const projectSkill = findProjectSkill()!
      // Only analyze messages since the last check — the skill definition
      // provides enough context for the classifier to understand corrections
      const newMessages = context.messages.slice(lastAnalyzedIndex)
      lastAnalyzedIndex = context.messages.length

      return [
        createUserMessage({
          content: `You are analyzing a conversation where a user is executing a skill (a repeatable process).
Your job: identify if the user's recent messages contain preferences, requests, or corrections that should be permanently added to the skill definition for future runs.

<skill_definition>
${projectSkill.content}
</skill_definition>

<recent_messages>
${formatRecentMessages(newMessages)}
</recent_messages>

Look for:
- Requests to add, change, or remove steps: "can you also ask me X", "please do Y too", "don't do Z"
- Preferences about how steps should work: "ask me about energy levels", "note the time", "use a casual tone"
- Corrections: "no, do X instead", "always use Y", "make sure to..."

Ignore:
- Routine conversation that doesn't generalize (one-time answers, chitchat)
- Things the skill already does

Output a JSON array inside <updates> tags. Each item: {"section": "which step/section to modify or 'new step'", "change": "what to add/modify", "reason": "which user message prompted this"}.
Output <updates>[]</updates> if no updates are needed.`,
        }),
      ]
    },

    systemPrompt:
      'You detect user preferences and process improvements during skill execution. Flag anything the user asks for that should be remembered for next time.',

    useTools: false,

    parseResponse(content) {
      const updatesStr = extractTag(content, 'updates')
      if (!updatesStr) {
        return []
      }
      try {
        return jsonParse(updatesStr) as SkillUpdate[]
      } catch {
        return []
      }
    },

    logResult(result, context) {
      if (result.type === 'success' && result.result.length > 0) {
        const projectSkill = findProjectSkill()
        const skillName = projectSkill?.skillName ?? 'unknown'

        context.toolUseContext.setAppState(prev => ({
          ...prev,
          skillImprovement: {
            suggestion: { skillName, updates: result.result },
          },
        }))
      }
    },

    getModel: getUtilityModel,
  }

  return createApiQueryHook(config)
}

export function initSkillImprovement(): void {
  if (getInitialSettings()?.skillImprovement ?? false) {
    registerPostSamplingHook(createSkillImprovementHook())
  }
}
