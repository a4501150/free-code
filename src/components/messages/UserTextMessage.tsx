import { feature } from 'bun:bundle'
import type { TextBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import * as React from 'react'
import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import {
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  TASK_NOTIFICATION_TAG,
  TEAMMATE_MESSAGE_TAG,
  TICK_TAG,
} from '../../constants/xml.js'
import { isAgentSwarmsEnabled } from '../../utils/agentSwarmsEnabled.js'
import {
  extractTag,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
} from '../../utils/messages.js'
import { InterruptedByUser } from '../InterruptedByUser.js'
import { MessageResponse } from '../MessageResponse.js'
import { UserAgentNotificationMessage } from './UserAgentNotificationMessage.js'
import { UserBashInputMessage } from './UserBashInputMessage.js'
import { UserBashOutputMessage } from './UserBashOutputMessage.js'
import { UserCommandMessage } from './UserCommandMessage.js'
import { UserLocalCommandOutputMessage } from './UserLocalCommandOutputMessage.js'
import { UserMemoryInputMessage } from './UserMemoryInputMessage.js'
import { UserPlanMessage } from './UserPlanMessage.js'
import { UserPromptMessage } from './UserPromptMessage.js'
import { UserResourceUpdateMessage } from './UserResourceUpdateMessage.js'
import { UserTeammateMessage } from './UserTeammateMessage.js'
import * as userChannelNs from './UserChannelMessage.js'

type Props = {
  addMargin: boolean
  param: TextBlockParam
  verbose: boolean
  planContent?: string
  isTranscriptMode?: boolean
  timestamp?: string
}

export function UserTextMessage({
  addMargin,
  param,
  verbose,
  planContent,
  isTranscriptMode,
  timestamp,
}: Props): React.ReactNode {
  if (param.text.trim() === NO_CONTENT_MESSAGE) {
    return null
  }

  // Plan to implement message (cleared context flow)
  if (planContent) {
    return <UserPlanMessage addMargin={addMargin} planContent={planContent} />
  }

  if (extractTag(param.text, TICK_TAG)) {
    return null
  }

  // Hide synthetic caveat messages (should be filtered by isMeta, this is defensive)
  if (param.text.includes(`<${LOCAL_COMMAND_CAVEAT_TAG}>`)) {
    return null
  }

  // Show bash output
  if (
    param.text.startsWith('<bash-stdout') ||
    param.text.startsWith('<bash-stderr')
  ) {
    return <UserBashOutputMessage content={param.text} verbose={verbose} />
  }

  // Show command output
  if (
    param.text.startsWith('<local-command-stdout') ||
    param.text.startsWith('<local-command-stderr')
  ) {
    return <UserLocalCommandOutputMessage content={param.text} />
  }

  // Handle interruption messages specially
  if (
    param.text === INTERRUPT_MESSAGE ||
    param.text === INTERRUPT_MESSAGE_FOR_TOOL_USE
  ) {
    return (
      <MessageResponse height={1}>
        <InterruptedByUser />
      </MessageResponse>
    )
  }

  // Bash inputs!
  // startsWith (not includes): synthetic messages always begin with the tag —
  // see processBashCommand.tsx, processSlashCommand.tsx, swarm/inProcessRunner.ts,
  // tasks/*/notifications, services/mcp/channelNotification.ts.
  // Using `.includes()` here would route any user-pasted prompt that mentions
  // these tag names into a synthetic-message renderer, which then returns null
  // (e.g. UserAgentNotificationMessage with no <summary>) and the user's prompt
  // vanishes from the REPL. user-memory-input / mcp-resource-update /
  // mcp-polling-update kept as `.includes()` because their constructors aren't
  // visible in src/ — too risky to assume their text-prefix shape.
  if (param.text.startsWith('<bash-input>')) {
    return <UserBashInputMessage addMargin={addMargin} param={param} />
  }

  // Slash commands/
  // The main slash-command path (formatCommandInputTags in messages.ts) emits
  // `<command-name>…</command-name>\n<command-message>…</command-message>\n…`,
  // so the synthetic text starts with <command-name>, not <command-message>.
  // Loading-state metadata (formatSlashCommandLoadingMetadata,
  // formatSkillLoadingMetadata) starts with <command-message>. Match both —
  // and require the <command-message> tag to actually be present so a stray
  // user paste of `<command-name>…` without it falls through to UserPromptMessage.
  if (
    (param.text.startsWith(`<${COMMAND_NAME_TAG}>`) ||
      param.text.startsWith(`<${COMMAND_MESSAGE_TAG}>`)) &&
    param.text.includes(`<${COMMAND_MESSAGE_TAG}>`)
  ) {
    return <UserCommandMessage addMargin={addMargin} param={param} />
  }

  if (param.text.includes('<user-memory-input>')) {
    return <UserMemoryInputMessage addMargin={addMargin} text={param.text} />
  }

  // Teammate messages - only check when swarms enabled
  if (
    isAgentSwarmsEnabled() &&
    param.text.startsWith(`<${TEAMMATE_MESSAGE_TAG}`)
  ) {
    return (
      <UserTeammateMessage
        addMargin={addMargin}
        param={param}
        isTranscriptMode={isTranscriptMode}
      />
    )
  }

  // Task notifications (agent completions, bash completions, etc.)
  if (param.text.startsWith(`<${TASK_NOTIFICATION_TAG}`)) {
    return <UserAgentNotificationMessage addMargin={addMargin} param={param} />
  }

  // MCP resource and polling update notifications
  if (
    param.text.includes('<mcp-resource-update') ||
    param.text.includes('<mcp-polling-update')
  ) {
    return <UserResourceUpdateMessage addMargin={addMargin} param={param} />
  }

  // Inbound channel message (MCP server push).
  if (feature('KAIROS') || feature('KAIROS_CHANNELS')) {
    if (param.text.startsWith('<channel source="')) {
      const { UserChannelMessage } = userChannelNs
      return <UserChannelMessage addMargin={addMargin} param={param} />
    }
  }

  // User prompts>
  return (
    <UserPromptMessage
      addMargin={addMargin}
      param={param}
      isTranscriptMode={isTranscriptMode}
      timestamp={timestamp}
    />
  )
}
