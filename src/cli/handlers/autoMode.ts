/**
 * Auto mode subcommand handlers — dump default/merged classifier rules and
 * critique user-written rules. Dynamically imported when `claude auto-mode ...` runs.
 */

import { errorMessage } from '../../utils/errors.js'
import {
  getMainLoopModel,
  parseUserSpecifiedModel,
} from '../../utils/model/model.js'
import {
  type AutoModeRules,
  buildDefaultExternalSystemPrompt,
  buildExternalAutoModeRules,
  getDefaultExternalAutoModeRules,
} from '../../utils/permissions/yoloClassifier.js'
import { getTrustedAutoModeRuleSections } from '../../utils/settings/settings.js'
import { sideQuery } from '../../utils/sideQuery.js'

function writeRules(rules: AutoModeRules): void {
  process.stdout.write(rules.endsWith('\n') ? rules : rules + '\n')
}

export function autoModeDefaultsHandler(): void {
  writeRules(getDefaultExternalAutoModeRules())
}

/**
 * Dump the effective auto mode permissions template: trusted settings where
 * provided, external defaults otherwise.
 */
export function autoModeConfigHandler(): void {
  writeRules(buildExternalAutoModeRules(getTrustedAutoModeRuleSections()))
}

const CRITIQUE_SYSTEM_PROMPT =
  'You are an expert reviewer of auto mode classifier rules for Claude Code.\n' +
  '\n' +
  'Claude Code has an "auto mode" that uses an AI classifier to decide whether ' +
  'tool calls should be auto-approved or require user confirmation. Users can ' +
  'replace the environment, deny, and allow sections in settings.autoMode.\n' +
  '\n' +
  "Your job is to critique the user's custom rules for clarity, completeness, " +
  'and potential issues. The classifier is an LLM that reads these rules as ' +
  'part of its system prompt.\n' +
  '\n' +
  'For each rule, evaluate:\n' +
  '1. **Clarity**: Is the rule unambiguous? Could the classifier misinterpret it?\n' +
  "2. **Completeness**: Are there gaps or edge cases the rule doesn't cover?\n" +
  '3. **Conflicts**: Do any of the rules conflict with each other?\n' +
  '4. **Actionability**: Is the rule specific enough for the classifier to act on?\n' +
  '\n' +
  'Be concise and constructive. Only comment on rules that could be improved. ' +
  'If all rules look good, say so.'

export async function autoModeCritiqueHandler(options: {
  model?: string
}): Promise<void> {
  const sections = getTrustedAutoModeRuleSections()

  if (!sections) {
    process.stdout.write(
      'No custom auto mode rule sections found.\n\n' +
        'Add rules to your settings file under autoMode.environment, autoMode.deny, or autoMode.allow.\n' +
        'Run `claude auto-mode defaults` to see the default rules for reference.\n',
    )
    return
  }

  const model = options.model
    ? parseUserSpecifiedModel(options.model)
    : getMainLoopModel()

  const rules = buildExternalAutoModeRules(sections)
  const classifierPrompt = buildDefaultExternalSystemPrompt().replace(
    getDefaultExternalAutoModeRules(),
    rules,
  )

  process.stdout.write('Analyzing your auto mode rules…\n\n')

  let response
  try {
    response = await sideQuery({
      querySource: 'auto_mode_critique',
      model,
      system: CRITIQUE_SYSTEM_PROMPT,
      skipSystemPromptPrefix: true,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content:
            'Here is the full classifier system prompt that the auto mode classifier receives:\n\n' +
            '<classifier_system_prompt>\n' +
            classifierPrompt +
            '\n</classifier_system_prompt>\n\n' +
            "Here are the user's custom auto mode section replacements from settings.autoMode:\n\n" +
            '<custom_auto_mode_sections>\n' +
            JSON.stringify(sections, null, 2) +
            '\n</custom_auto_mode_sections>\n\n' +
            'Please critique these custom rules.',
        },
      ],
    })
  } catch (error) {
    process.stderr.write(
      'Failed to analyze rules: ' + errorMessage(error) + '\n',
    )
    process.exitCode = 1
    return
  }

  const textBlock = response.content.find(block => block.type === 'text')
  if (textBlock?.type === 'text') {
    process.stdout.write(textBlock.text + '\n')
  } else {
    process.stdout.write('No critique was generated. Please try again.\n')
  }
}
