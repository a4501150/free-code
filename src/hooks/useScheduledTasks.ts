import { useEffect, useRef } from 'react'
import { isAssistantCronEnabled } from '../tools/ScheduleCronTool/prompt.js'
import type { Message } from '../types/message.js'
import { getCronJitterConfig } from '../utils/cronJitterConfig.js'
import { createCronScheduler } from '../utils/cronScheduler.js'
import { enqueuePendingNotification } from '../utils/messageQueueManager.js'
import { createScheduledTaskFireMessage } from '../utils/messages.js'
import { WORKLOAD_CRON } from '../utils/workloadContext.js'

type Props = {
  isLoading: boolean
  /**
   * When true, bypasses the isLoading gate so tasks can enqueue while a
   * query is streaming rather than deferring to the next 1s check tick
   * after the turn ends. The assistant session is event-driven — while it
   * idles isLoading is false and the scheduler fires directly; the bypass
   * only covers the case where a cron comes due mid-turn. The prompt is
   * enqueued at 'later' priority either way and drains between turns.
   */
  assistantMode?: boolean
  setMessages: React.Dispatch<React.SetStateAction<Message[]>>
}

/**
 * REPL wrapper for the cron scheduler. Mounts the scheduler once and tears
 * it down on unmount. Fired prompts go into the command queue as 'later'
 * priority, which the REPL drains via useCommandQueue between turns.
 *
 * Scheduler core (timer, file watcher, fire logic) lives in cronScheduler.ts
 * so SDK/-p mode can share it — see print.ts for the headless wiring.
 */
export function useScheduledTasks({
  isLoading,
  assistantMode = false,
  setMessages,
}: Props): void {
  // Latest-value ref so the scheduler's isLoading() getter doesn't capture
  // a stale closure. The effect mounts once; isLoading changes every turn.
  const isLoadingRef = useRef(isLoading)
  isLoadingRef.current = isLoading

  useEffect(() => {
    // Runtime gate checked here (not at the hook call site) so the hook
    // stays unconditionally mounted — rules-of-hooks forbid wrapping the
    // call in a dynamic condition. getFeatureValue_CACHED_WITH_REFRESH
    // reads from disk; the 5-min TTL fires a background refetch but the
    // effect won't re-run on value flip (assistantMode is the only dep),
    // so this guard alone is launch-grain. The mid-session killswitch is
    // the isKilled option below — check() polls it every tick.
    if (!isAssistantCronEnabled()) return

    // System-generated — hidden from queue preview and transcript UI.
    // In brief mode, executeForkedSlashCommand runs as a background
    // subagent and returns no visible messages. In normal mode,
    // isMeta is only propagated for plain-text prompts (via
    // processTextPrompt); slash commands like /context:fork do not
    // forward isMeta, so their messages remain visible in the
    // transcript. This is acceptable since normal mode is not the
    // primary use case for scheduled tasks.
    const enqueueForLead = (prompt: string) =>
      enqueuePendingNotification({
        value: prompt,
        mode: 'prompt',
        priority: 'later',
        isMeta: true,
        // Threaded through to cc_workload= in the billing-header
        // attribution block so the API can serve cron-initiated requests
        // at lower QoS when capacity is tight. No human is actively
        // waiting on this response.
        workload: WORKLOAD_CRON,
      })

    const scheduler = createCronScheduler({
      // Missed-task surfacing (onFire fallback). The missed list is populated
      // from disk at scheduler startup — durable crons only.
      onFire: enqueueForLead,
      // Normal fires receive the full CronTask.
      onFireTask: task => {
        const msg = createScheduledTaskFireMessage(
          `Running scheduled task (${formatCronFireTime(new Date())})`,
        )
        setMessages(prev => [...prev, msg])
        enqueueForLead(task.prompt)
      },
      isLoading: () => isLoadingRef.current,
      assistantMode,
      getJitterConfig: getCronJitterConfig,
      isKilled: () => !isAssistantCronEnabled(),
    })
    scheduler.start()
    return () => scheduler.stop()
    // assistantMode is stable for the session lifetime; setMessages is a
    // stable useCallback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantMode])
}

function formatCronFireTime(d: Date): string {
  return d
    .toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
    .replace(/,? at |, /, ' ')
    .replace(/ ([AP]M)/, (_, ampm) => ampm.toLowerCase())
}
