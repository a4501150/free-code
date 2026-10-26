import type { DomainUsage as Usage } from './types/domain.js'
import chalk from 'chalk'
import {
  addToTotalCostState,
  addToTotalLinesChanged,
  getCostCounter,
  getModelAPIDurationMs,
  getModelLatencyStats,
  getModelUsage,
  type ModelLatencyStats,
  getSdkBetas,
  getSessionId,
  getTokenCounter,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  getTotalCacheCreationInputTokens,
  getTotalCacheReadInputTokens,
  getTotalCostUSD,
  getTotalDuration,
  getTotalInputTokens,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalOutputTokens,
  getTotalToolDuration,
  getTotalWebSearchRequests,
  getUsageForModel,
  hasUnknownModelCost,
  resetCostState,
  resetStateForTests,
  setCostStateForRestore,
  setHasUnknownModelCost,
} from './bootstrap/state.js'
import type { ModelUsage } from 'src/structuredProtocol/index.js'
import {
  getCurrentProjectConfig,
  saveCurrentProjectConfig,
} from './utils/config.js'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
} from './utils/context.js'
import { isFastModeEnabled } from './utils/fastMode.js'
import sumBy from 'lodash-es/sumBy.js'
import {
  formatDuration,
  formatNumber,
  formatTokensPerSecond,
} from './utils/format.js'
import {
  getPublicModelDisplayName,
  renderModelName,
} from './utils/model/model.js'
export {
  getTotalCostUSD as getTotalCost,
  getTotalDuration,
  getTotalAPIDuration,
  getTotalAPIDurationWithoutRetries,
  getModelAPIDurationMs,
  addToTotalLinesChanged,
  getTotalLinesAdded,
  getTotalLinesRemoved,
  getTotalInputTokens,
  getTotalOutputTokens,
  getTotalCacheReadInputTokens,
  getTotalCacheCreationInputTokens,
  getTotalWebSearchRequests,
  formatCost,
  hasUnknownModelCost,
  resetStateForTests,
  resetCostState,
  setHasUnknownModelCost,
  getModelUsage,
  getModelLatencyStats,
  getUsageForModel,
}
export type { ModelLatencyStats }

type StoredCostState = {
  totalCostUSD: number
  totalAPIDuration: number
  totalAPIDurationWithoutRetries: number
  totalToolDuration: number
  totalLinesAdded: number
  totalLinesRemoved: number
  lastDuration: number | undefined
  modelUsage: { [modelName: string]: ModelUsage } | undefined
  modelAPIDurationMs?: { [modelName: string]: number }
  modelLatencyStats?: {
    [modelName: string]: {
      decodeMs: number
      outputTokens: number
      prefillMs?: number
      prefillTokens?: number
    }
  }
}

/**
 * Gets stored cost state from project config for a specific session.
 * Returns the cost data if the session ID matches, or undefined otherwise.
 * Use this to read costs BEFORE overwriting the config with saveCurrentSessionCosts().
 */
export function getStoredSessionCosts(
  sessionId: string,
): StoredCostState | undefined {
  const projectConfig = getCurrentProjectConfig()

  // Only return costs if this is the same session that was last saved
  if (projectConfig.lastSessionId !== sessionId) {
    return undefined
  }

  // Build model usage with context windows
  let modelUsage: { [modelName: string]: ModelUsage } | undefined
  if (projectConfig.lastModelUsage) {
    modelUsage = Object.fromEntries(
      Object.entries(projectConfig.lastModelUsage).map(([model, usage]) => [
        model,
        {
          ...usage,
          contextWindow: getContextWindowForModel(model, getSdkBetas()),
          maxOutputTokens: getModelMaxOutputTokens(model),
        },
      ]),
    )
  }

  return {
    totalCostUSD: projectConfig.lastCost ?? 0,
    totalAPIDuration: projectConfig.lastAPIDuration ?? 0,
    totalAPIDurationWithoutRetries:
      projectConfig.lastAPIDurationWithoutRetries ?? 0,
    // Copy: the cached project config object must not alias session state
    modelAPIDurationMs: projectConfig.lastModelAPIDurationMs && {
      ...projectConfig.lastModelAPIDurationMs,
    },
    modelLatencyStats:
      projectConfig.lastModelLatencyStats &&
      Object.fromEntries(
        Object.entries(projectConfig.lastModelLatencyStats).map(
          ([model, stats]) => [model, { ...stats }],
        ),
      ),
    totalToolDuration: projectConfig.lastToolDuration ?? 0,
    totalLinesAdded: projectConfig.lastLinesAdded ?? 0,
    totalLinesRemoved: projectConfig.lastLinesRemoved ?? 0,
    lastDuration: projectConfig.lastDuration,
    modelUsage,
  }
}

/**
 * Restores cost state from project config when resuming a session.
 * Only restores if the session ID matches the last saved session.
 * @returns true if cost state was restored, false otherwise
 */
export function restoreCostStateForSession(sessionId: string): boolean {
  const data = getStoredSessionCosts(sessionId)
  if (!data) {
    return false
  }
  setCostStateForRestore(data)
  return true
}

/**
 * Saves the current session's costs to project config.
 * Call this before switching sessions to avoid losing accumulated costs.
 */
export function saveCurrentSessionCosts(): void {
  saveCurrentProjectConfig(current => ({
    ...current,
    lastCost: getTotalCostUSD(),
    lastAPIDuration: getTotalAPIDuration(),
    lastAPIDurationWithoutRetries: getTotalAPIDurationWithoutRetries(),
    lastModelAPIDurationMs: { ...getModelAPIDurationMs() },
    lastModelLatencyStats: Object.fromEntries(
      Object.entries(getModelLatencyStats()).map(([model, stats]) => [
        model,
        { ...stats },
      ]),
    ),
    lastToolDuration: getTotalToolDuration(),
    lastDuration: getTotalDuration(),
    lastLinesAdded: getTotalLinesAdded(),
    lastLinesRemoved: getTotalLinesRemoved(),
    lastModelUsage: Object.fromEntries(
      Object.entries(getModelUsage()).map(([model, usage]) => [
        model,
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheCreationInputTokens: usage.cacheCreationInputTokens,
          webSearchRequests: usage.webSearchRequests,
          costUSD: usage.costUSD,
        },
      ]),
    ),
    lastSessionId: getSessionId(),
  }))
}

function formatCost(cost: number, maxDecimalPlaces: number = 4): string {
  return `$${cost > 0.5 ? round(cost, 100).toFixed(2) : cost.toFixed(maxDecimalPlaces)}`
}

/** Session-average decode speed, or undefined if no streaming call finished yet. */
export function getAverageOutputTokensPerSecond(): number | undefined {
  const decodeStats = Object.values(getModelLatencyStats())
  const tokens = sumBy(decodeStats, 'outputTokens')
  const ms = sumBy(decodeStats, 'decodeMs')
  return ms > 0 ? (tokens * 1000) / ms : undefined
}

const AVG_SPEED_SUFFIX = ' avg (decode, successful streaming calls)'

/** Session-average speed, phrased identically in /cost text and the stats panel. */
export function formatAverageOutputSpeed(): string | undefined {
  const avg = getAverageOutputTokensPerSecond()
  return avg === undefined
    ? undefined
    : formatTokensPerSecond(avg) + AVG_SPEED_SUFFIX
}

export type ModelUsageRow = {
  displayName: string
  /** Raw model keys aggregated into this row, for the block header. */
  modelIds: string[]
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
  /** Decode speed when enough streaming samples exist for this model. */
  tokensPerSecond: number | undefined
  /** TTFT-based prefill speed; undefined without prefill samples. */
  prefillTokensPerSecond: number | undefined
}

/**
 * Session usage grouped by public model display name — the same grouping the
 * /cost text block renders, exposed so the /usage tab can draw rows with it.
 */
export function getModelUsageRows(): ModelUsageRow[] {
  const modelUsageMap = getModelUsage()
  const usageByShortName: { [shortName: string]: ModelUsage } = {}
  const modelIdsByShortName: { [shortName: string]: string[] } = {}
  const decodeStatsByShortName: {
    [shortName: string]: {
      decodeMs: number
      outputTokens: number
      prefillMs: number
      prefillTokens: number
    }
  } = {}
  const decodeStats = getModelLatencyStats()
  for (const [model, usage] of Object.entries(modelUsageMap)) {
    const shortName = getPublicModelDisplayName(model) || model
    const decode = decodeStats[model]
    if (decode) {
      const prev = decodeStatsByShortName[shortName] ?? {
        decodeMs: 0,
        outputTokens: 0,
        prefillMs: 0,
        prefillTokens: 0,
      }
      decodeStatsByShortName[shortName] = {
        decodeMs: prev.decodeMs + decode.decodeMs,
        outputTokens: prev.outputTokens + decode.outputTokens,
        prefillMs: prev.prefillMs + decode.prefillMs,
        prefillTokens: prev.prefillTokens + decode.prefillTokens,
      }
    }
    if (!usageByShortName[shortName]) {
      usageByShortName[shortName] = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        webSearchRequests: 0,
        costUSD: 0,
        contextWindow: 0,
        maxOutputTokens: 0,
      }
      modelIdsByShortName[shortName] = []
    }
    modelIdsByShortName[shortName]!.push(model)
    const accumulated = usageByShortName[shortName]
    accumulated.inputTokens += usage.inputTokens
    accumulated.outputTokens += usage.outputTokens
    accumulated.cacheReadInputTokens += usage.cacheReadInputTokens
    accumulated.cacheCreationInputTokens += usage.cacheCreationInputTokens
    accumulated.webSearchRequests += usage.webSearchRequests
    accumulated.costUSD += usage.costUSD
  }

  return Object.entries(usageByShortName).map(([shortName, usage]) => {
    const decode = decodeStatsByShortName[shortName]
    return {
      displayName: renderModelName(shortName),
      modelIds: modelIdsByShortName[shortName]!,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
      webSearchRequests: usage.webSearchRequests,
      costUSD: usage.costUSD,
      tokensPerSecond:
        decode && decode.decodeMs > 0 && decode.outputTokens > 0
          ? (decode.outputTokens * 1000) / decode.decodeMs
          : undefined,
      prefillTokensPerSecond:
        decode && decode.prefillMs > 0 && decode.prefillTokens > 0
          ? (decode.prefillTokens * 1000) / decode.prefillMs
          : undefined,
    }
  })
}

export function formatModelUsageLine(row: ModelUsageRow): string {
  return (
    `  ${formatNumber(row.inputTokens)} input, ` +
    `${formatNumber(row.outputTokens)} output, ` +
    `${formatNumber(row.cacheReadInputTokens)} cache read, ` +
    `${formatNumber(row.cacheCreationInputTokens)} cache write` +
    (row.webSearchRequests > 0
      ? `, ${formatNumber(row.webSearchRequests)} web search`
      : '') +
    ` (${formatCost(row.costUSD)})`
  )
}

function formatModelUsage(): string {
  const rows = getModelUsageRows()
  if (rows.length === 0) {
    return 'Usage:                 0 input, 0 output, 0 cache read, 0 cache write'
  }
  let result = 'Usage by model:'
  for (const row of rows) {
    result += `\n\n` + `  ${row.displayName} (${row.modelIds.join(', ')})`
    result += `\n` + `Usage:`.padStart(21) + formatModelUsageLine(row)
    if (row.prefillTokensPerSecond !== undefined) {
      result +=
        `\n` +
        `Prefill:`.padStart(21) +
        `  ${formatTokensPerSecond(row.prefillTokensPerSecond)}`
    }
    if (row.tokensPerSecond !== undefined) {
      result +=
        `\n` +
        `Decode:`.padStart(21) +
        `  ${formatTokensPerSecond(row.tokensPerSecond)}`
    }
  }
  return result
}

export function formatTotalCost(): string {
  const costDisplay =
    formatCost(getTotalCostUSD()) +
    (hasUnknownModelCost()
      ? ' (costs may be inaccurate due to usage of unknown models)'
      : '')

  const modelUsageDisplay = formatModelUsage()

  const avgSpeed = formatAverageOutputSpeed()
  return chalk.dim(
    `Total cost:            ${costDisplay}\n` +
      `Total duration (API):  ${formatDuration(getTotalAPIDuration())}
Total duration (wall): ${formatDuration(getTotalDuration())}
Total output speed:    ${avgSpeed ?? '-'}
Total code changes:    ${getTotalLinesAdded()} ${getTotalLinesAdded() === 1 ? 'line' : 'lines'} added, ${getTotalLinesRemoved()} ${getTotalLinesRemoved() === 1 ? 'line' : 'lines'} removed
${modelUsageDisplay}`,
  )
}

function round(number: number, precision: number): number {
  return Math.round(number * precision) / precision
}

function addToTotalModelUsage(
  cost: number,
  usage: Usage,
  model: string,
): ModelUsage {
  const modelUsage = getUsageForModel(model) ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
  }

  modelUsage.inputTokens += usage.input_tokens
  modelUsage.outputTokens += usage.output_tokens
  modelUsage.cacheReadInputTokens += usage.cache_read_input_tokens ?? 0
  modelUsage.cacheCreationInputTokens += usage.cache_creation_input_tokens ?? 0
  modelUsage.webSearchRequests +=
    (usage.server_tool_use as { web_search_requests?: number } | undefined)
      ?.web_search_requests ?? 0
  modelUsage.costUSD += cost
  modelUsage.contextWindow = getContextWindowForModel(model, getSdkBetas())
  modelUsage.maxOutputTokens = getModelMaxOutputTokens(model)
  return modelUsage
}

export function addToTotalSessionCost(
  cost: number,
  usage: Usage,
  model: string,
): number {
  const modelUsage = addToTotalModelUsage(cost, usage, model)
  addToTotalCostState(cost, modelUsage, model)

  const attrs =
    isFastModeEnabled() && usage.speed === 'fast'
      ? { model, speed: 'fast' }
      : { model }

  getCostCounter()?.add(cost, attrs)
  getTokenCounter()?.add(usage.input_tokens, { ...attrs, type: 'input' })
  getTokenCounter()?.add(usage.output_tokens, { ...attrs, type: 'output' })
  getTokenCounter()?.add(usage.cache_read_input_tokens ?? 0, {
    ...attrs,
    type: 'cacheRead',
  })
  getTokenCounter()?.add(usage.cache_creation_input_tokens ?? 0, {
    ...attrs,
    type: 'cacheCreation',
  })

  return cost
}
