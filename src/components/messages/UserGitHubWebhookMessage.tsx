/**
 * Renders <github-webhook-activity> XML messages delivered by the
 * PR subscription system during proactive tick check-ins.
 */

import * as React from 'react'
import { Box, Text } from '../../ink.js'

interface Props {
  addMargin: boolean
  param: { text: string }
}

interface WebhookEvent {
  action: string
  pr_number?: string
  repo?: string
  author?: string
  title?: string
  body?: string
}

function parseWebhookXml(text: string): WebhookEvent {
  // Simple XML attribute parser for <github-webhook-activity> tags
  const event: WebhookEvent = { action: 'unknown' }

  const actionMatch = text.match(/action="([^"]*)"/)
  if (actionMatch) event.action = actionMatch[1]!

  const prMatch = text.match(/pr="([^"]*)"/)
  if (prMatch) event.pr_number = prMatch[1]

  const repoMatch = text.match(/repo="([^"]*)"/)
  if (repoMatch) event.repo = repoMatch[1]

  const authorMatch = text.match(/author="([^"]*)"/)
  if (authorMatch) event.author = authorMatch[1]

  const titleMatch = text.match(/title="([^"]*)"/)
  if (titleMatch) event.title = titleMatch[1]

  // Body is between tags
  const bodyMatch = text.match(
    /<github-webhook-activity[^>]*>([\s\S]*?)<\/github-webhook-activity>/,
  )
  if (bodyMatch?.[1]?.trim()) event.body = bodyMatch[1].trim()

  return event
}

function getActionColor(action: string): string {
  switch (action) {
    case 'opened':
      return 'green'
    case 'closed':
      return 'red'
    case 'merged':
      return 'magenta'
    case 'commented':
    case 'reviewed':
      return 'cyan'
    case 'approved':
      return 'green'
    case 'changes_requested':
      return 'yellow'
    case 'pushed':
    case 'synchronize':
      return 'blue'
    default:
      return 'gray'
  }
}

function getActionIcon(action: string): string {
  switch (action) {
    case 'opened':
      return '+'
    case 'closed':
      return 'x'
    case 'merged':
      return '*'
    case 'commented':
      return '#'
    case 'reviewed':
    case 'approved':
      return 'v'
    case 'changes_requested':
      return '!'
    case 'pushed':
    case 'synchronize':
      return '>'
    default:
      return '-'
  }
}

export function UserGitHubWebhookMessage({
  addMargin,
  param,
}: Props): React.ReactNode {
  const event = parseWebhookXml(param.text)
  const color = getActionColor(event.action)
  const icon = getActionIcon(event.action)

  return (
    <Box
      flexDirection="column"
      marginTop={addMargin ? 1 : 0}
      paddingLeft={1}
    >
      <Box>
        <Text color={color} bold>
          [{icon}]
        </Text>
        <Text> </Text>
        <Text color={color} bold>
          PR {event.action}
        </Text>
        {event.repo && event.pr_number && (
          <Text dimColor>
            {' '}
            {event.repo}#{event.pr_number}
          </Text>
        )}
        {event.author && <Text dimColor> by {event.author}</Text>}
      </Box>
      {event.title && (
        <Box paddingLeft={4}>
          <Text>{event.title}</Text>
        </Box>
      )}
      {event.body && (
        <Box paddingLeft={4}>
          <Text dimColor>{event.body.slice(0, 200)}</Text>
        </Box>
      )}
    </Box>
  )
}
