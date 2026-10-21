/**
 * Task-state fixtures for unit tests: minimal filler objects with only the
 * fields a test actually reads passed as overrides. Runtime imports are
 * avoided (types only) so these stay cheap in the shared unit-test process.
 */

import type { LocalAgentTaskState } from '../src/tasks/LocalAgentTask/LocalAgentTask.js'
import type { LocalShellTaskState } from '../src/tasks/LocalShellTask/guards.js'
import type { TaskState } from '../src/tasks/types.js'

export function makeLocalAgentTask(
  overrides: Partial<LocalAgentTaskState> & { id: string },
): TaskState {
  return {
    id: overrides.id,
    type: 'local_agent',
    status: 'running',
    description: `task ${overrides.id}`,
    startTime: 0,
    outputFile: `/out/${overrides.id}`,
    outputOffset: 0,
    notified: false,
    agentId: overrides.id,
    prompt: 'prompt',
    agentType: 'general-purpose',
    retrieved: false,
    lastReportedToolCount: 0,
    lastReportedTokenCount: 0,
    isBackgrounded: true,
    pendingMessages: [],
    retain: false,
    diskLoaded: false,
    ...overrides,
  } as TaskState
}

export function makeLocalShellTask(
  overrides: Partial<LocalShellTaskState> & { id: string },
): TaskState {
  return {
    id: overrides.id,
    type: 'local_bash',
    status: 'running',
    description: `task ${overrides.id}`,
    startTime: 0,
    outputFile: `/out/${overrides.id}`,
    outputOffset: 0,
    notified: false,
    command: 'true',
    completionStatusSentInAttachment: false,
    shellCommand: null,
    lastReportedTotalLines: 0,
    isBackgrounded: true,
    kind: 'bash',
    ...overrides,
  } as TaskState
}
