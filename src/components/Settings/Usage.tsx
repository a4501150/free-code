import * as React from 'react'
import { useEffect, useState } from 'react'
import { extraUsage as extraUsageCommand } from 'src/commands/extra-usage/index.js'
import {
  formatCost,
  formatModelUsageLine,
  getModelLatencyStats,
  getModelUsageRows,
  getTotalAPIDuration,
  getTotalCost,
  getTotalDuration,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  hasUnknownModelCost,
  type ModelLatencyStats,
  type ModelUsageRow,
} from 'src/cost-tracker.js'
import type { Message } from 'src/types/message.js'
import {
  computePromptCacheSummary,
  formatPromptCacheLine,
} from 'src/services/api/promptCacheStats.js'
import { getSubscriptionType } from 'src/utils/auth.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  type ExtraUsage,
  fetchUtilization,
  type RateLimit,
  type Utilization,
} from '../../services/api/usage.js'
import {
  formatDuration,
  formatNumber,
  formatResetText,
  formatTokensPerSecond,
} from '../../utils/format.js'
import { logError } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { Byline } from '../design-system/Byline.js'
import { ProgressBar } from '../design-system/ProgressBar.js'

type LimitBarProps = {
  title: string
  limit: RateLimit
  maxWidth: number
  showTimeInReset?: boolean
  extraSubtext?: string
}

function LimitBar({
  title,
  limit,
  maxWidth,
  showTimeInReset = true,
  extraSubtext,
}: LimitBarProps): React.ReactNode {
  const { utilization, resets_at } = limit
  if (utilization === null) {
    return null
  }

  // Calculate usage percentage
  const usedText = `${Math.floor(utilization)}% used`

  let subtext: string | undefined
  if (resets_at) {
    subtext = `Resets ${formatResetText(resets_at, true, showTimeInReset)}`
  }

  if (extraSubtext) {
    if (subtext) {
      subtext = `${extraSubtext} · ${subtext}`
    } else {
      subtext = extraSubtext
    }
  }

  const maxBarWidth = 50
  const usedLabelSpace = 12
  if (maxWidth >= maxBarWidth + usedLabelSpace) {
    return (
      <Box flexDirection="column">
        <Text bold>{title}</Text>
        <Box flexDirection="row" gap={1}>
          <ProgressBar
            ratio={utilization / 100}
            width={maxBarWidth}
            fillColor="rate_limit_fill"
            emptyColor="rate_limit_empty"
          />
          <Text>{usedText}</Text>
        </Box>
        {subtext && <Text dimColor>{subtext}</Text>}
      </Box>
    )
  } else {
    return (
      <Box flexDirection="column">
        <Text>
          <Text bold>{title}</Text>
          {subtext && (
            <>
              <Text> </Text>
              <Text dimColor>· {subtext}</Text>
            </>
          )}
        </Text>
        <ProgressBar
          ratio={utilization / 100}
          width={maxWidth}
          fillColor="rate_limit_fill"
          emptyColor="rate_limit_empty"
        />
        <Text>{usedText}</Text>
      </Box>
    )
  }
}

const SESSION_LABEL_WIDTH = 23
// Indent + label width for rows nested under a "Usage by model" block header.
const MODEL_BLOCK_INDENT = '  '
const MODEL_ROW_LABEL_WIDTH = 14

function SessionRow({
  label,
  value,
}: {
  label: string
  value: React.ReactNode
}): React.ReactNode {
  return (
    <Text>
      {(label + ':').padEnd(SESSION_LABEL_WIDTH)}
      {value}
    </Text>
  )
}

function ModelRow({
  label,
  value,
  dim = false,
}: {
  label: string
  value: React.ReactNode
  dim?: boolean
}): React.ReactNode {
  const row = (
    <Text>
      {MODEL_BLOCK_INDENT}
      {(label + ':').padEnd(MODEL_ROW_LABEL_WIDTH)}
      {value}
    </Text>
  )
  return dim ? <Text dimColor>{row}</Text> : row
}

function ModelUsageBlock({
  row,
  messages,
}: {
  row: ModelUsageRow
  messages: Message[]
}): React.ReactNode {
  const decode = getModelLatencyStats()
  const stats = row.modelIds
    .map(id => decode[id])
    .filter((s): s is ModelLatencyStats => s !== undefined)
    .reduce(
      (acc, s) => ({
        decodeMs: acc.decodeMs + s.decodeMs,
        outputTokens: acc.outputTokens + s.outputTokens,
      }),
      { decodeMs: 0, outputTokens: 0 },
    )
  // Cache stats for this block only: main-thread records from this block's
  // models, so the line under the header describes exactly that block.
  const blockMessages = messages.filter(
    m =>
      m.type === 'assistant' &&
      row.modelIds.includes(m.message.model ?? '') &&
      !m.isSidechain,
  )
  const cacheSummary = computePromptCacheSummary(blockMessages)
  const cacheLine = cacheSummary
    ? formatPromptCacheLine(cacheSummary, Date.now(), 'Prompt cache')
    : null

  return (
    <Box flexDirection="column">
      <Text>
        {MODEL_BLOCK_INDENT}
        {row.displayName} ({row.modelIds.join(', ')})
      </Text>
      <ModelRow label="Usage" value={formatModelUsageLine(row).trimStart()} />
      {row.prefillTokensPerSecond !== undefined && (
        <ModelRow
          label="Prefill"
          value={`${formatTokensPerSecond(row.prefillTokensPerSecond)} avg`}
        />
      )}
      {row.tokensPerSecond !== undefined && (
        <ModelRow
          label="Decode"
          value={`${formatTokensPerSecond(row.tokensPerSecond)} avg`}
        />
      )}
      {stats.decodeMs > 0 && (
        <ModelRow
          label="Decode detail"
          dim
          value={`${formatNumber(stats.outputTokens)} out decoded in ${formatDuration(stats.decodeMs)}`}
        />
      )}
      {cacheLine && <Text dimColor>{MODEL_BLOCK_INDENT + cacheLine}</Text>}
    </Box>
  )
}

function SessionSection({
  messages,
}: {
  messages: Message[]
}): React.ReactNode {
  const linesAdded = getTotalLinesAdded()
  const linesRemoved = getTotalLinesRemoved()
  const usageRows = getModelUsageRows()
  const costDisplay = (
    <>
      {formatCost(getTotalCost())}
      {hasUnknownModelCost() ? (
        <Text dimColor>
          {' '}
          (costs may be inaccurate due to usage of unknown models)
        </Text>
      ) : null}
    </>
  )

  return (
    <Box flexDirection="column">
      <Text bold>Session</Text>
      <SessionRow label="Total cost" value={costDisplay} />
      <SessionRow
        label="Total duration (API)"
        value={formatDuration(getTotalAPIDuration())}
      />
      <SessionRow
        label="Total duration (wall)"
        value={formatDuration(getTotalDuration())}
      />
      <SessionRow
        label="Total code changes"
        value={`${linesAdded} ${linesAdded === 1 ? 'line' : 'lines'} added, ${linesRemoved} ${linesRemoved === 1 ? 'line' : 'lines'} removed`}
      />
      <Text>Usage by model:</Text>
      {usageRows.length === 0 ? (
        <SessionRow
          label="Usage"
          value="0 input, 0 output, 0 cache read, 0 cache write"
        />
      ) : (
        usageRows.map(row => (
          <ModelUsageBlock
            key={row.displayName}
            row={row}
            messages={messages}
          />
        ))
      )}
    </Box>
  )
}
export function Usage({ messages }: { messages: Message[] }): React.ReactNode {
  const [utilization, setUtilization] = useState<Utilization | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const { columns } = useTerminalSize()

  const availableWidth = columns - 2 // 2 for screen padding
  const maxWidth = Math.min(availableWidth, 80)

  const loadUtilization = React.useCallback(async () => {
    setIsLoading(true)
    setError(null)
    try {
      const data = await fetchUtilization()
      setUtilization(data)
    } catch (err) {
      logError(err as Error)
      const axiosError = err as { response?: { data?: unknown } }
      const responseBody = axiosError.response?.data
        ? jsonStringify(axiosError.response.data)
        : undefined
      setError(
        responseBody
          ? `Failed to load usage data: ${responseBody}`
          : 'Failed to load usage data',
      )
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadUtilization()
  }, [loadUtilization])

  useKeybinding(
    'settings:retry',
    () => {
      void loadUtilization()
    },
    { context: 'Settings', isActive: !!error && !isLoading },
  )

  let subscriptionContent: React.ReactNode = null
  if (error) {
    subscriptionContent = (
      <Box flexDirection="column" gap={1}>
        <Text color="error">Error: {error}</Text>
        <Text dimColor>
          <Byline>
            <ConfigurableShortcutHint
              action="settings:retry"
              context="Settings"
              description="retry"
            />
            <ConfigurableShortcutHint
              action="confirm:no"
              context="Settings"
              description="cancel"
            />
          </Byline>
        </Text>
      </Box>
    )
  } else if (!utilization) {
    subscriptionContent = <Text dimColor>Loading usage data…</Text>
  } else {
    // Only Max and Team plans have a Sonnet limit that differs from the weekly
    // limit (see rateLimitMessages.ts). For other plans the bar is redundant.
    // Show for null (unknown plan) to stay consistent with rateLimitMessages.ts,
    // which labels it "Sonnet limit" in that case.
    const subscriptionType = getSubscriptionType()
    const showSonnetBar =
      subscriptionType === 'max' ||
      subscriptionType === 'team' ||
      subscriptionType === null

    const limits = [
      {
        title: 'Current session',
        limit: utilization.five_hour,
      },
      {
        title: 'Current week (all models)',
        limit: utilization.seven_day,
      },
      ...(showSonnetBar
        ? [
            {
              title: 'Current week (Sonnet only)',
              limit: utilization.seven_day_sonnet,
            },
          ]
        : []),
    ]

    subscriptionContent = (
      <Box flexDirection="column" gap={1}>
        {limits.some(({ limit }) => limit) || (
          <Text dimColor>
            Subscription usage is only shown when logged in to a supported
            provider.
          </Text>
        )}

        {limits.map(
          ({ title, limit }) =>
            limit && (
              <LimitBar
                key={title}
                title={title}
                limit={limit}
                maxWidth={maxWidth}
              />
            ),
        )}

        {utilization.extra_usage && (
          <ExtraUsageSection
            extraUsage={utilization.extra_usage}
            maxWidth={maxWidth}
          />
        )}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" gap={1} width="100%">
      <SessionSection messages={messages} />
      {subscriptionContent}
      <Text dimColor>
        <ConfigurableShortcutHint
          action="confirm:no"
          context="Settings"
          description="cancel"
        />
      </Text>
    </Box>
  )
}

type ExtraUsageSectionProps = {
  extraUsage: ExtraUsage
  maxWidth: number
}

const EXTRA_USAGE_SECTION_TITLE = 'Extra usage'

function ExtraUsageSection({
  extraUsage,
  maxWidth,
}: ExtraUsageSectionProps): React.ReactNode {
  const subscriptionType = getSubscriptionType()
  const isProOrMax = subscriptionType === 'pro' || subscriptionType === 'max'
  if (!isProOrMax) {
    // Only show to Pro and Max, consistent with claude.ai non-admin usage settings
    return false
  }

  if (!extraUsage.is_enabled) {
    if (extraUsageCommand.isEnabled()) {
      return (
        <Box flexDirection="column">
          <Text bold>{EXTRA_USAGE_SECTION_TITLE}</Text>
          <Text dimColor>Extra usage not enabled · /extra-usage to enable</Text>
        </Box>
      )
    }

    return null
  }

  if (extraUsage.monthly_limit === null) {
    return (
      <Box flexDirection="column">
        <Text bold>{EXTRA_USAGE_SECTION_TITLE}</Text>
        <Text dimColor>Unlimited</Text>
      </Box>
    )
  }

  if (
    typeof extraUsage.used_credits !== 'number' ||
    typeof extraUsage.utilization !== 'number'
  ) {
    return null
  }

  const formattedUsedCredits = formatCost(extraUsage.used_credits / 100, 2)
  const formattedMonthlyLimit = formatCost(extraUsage.monthly_limit / 100, 2)
  const now = new Date()
  const oneMonthReset = new Date(now.getFullYear(), now.getMonth() + 1, 1)

  return (
    <LimitBar
      title={EXTRA_USAGE_SECTION_TITLE}
      limit={{
        utilization: extraUsage.utilization,
        // Not applicable for enterprises, but for now we don't render this for them
        resets_at: oneMonthReset.toISOString(),
      }}
      showTimeInReset={false}
      extraSubtext={`${formattedUsedCredits} / ${formattedMonthlyLimit} spent`}
      maxWidth={maxWidth}
    />
  )
}
