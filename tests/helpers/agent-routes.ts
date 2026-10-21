import type { MockResponse } from './sse-encoder'
import type { QueueSelectorEntry } from './mock-server'

/**
 * Mock-server routing by system prompt: the subagent's prompt names it an
 * agent, the main thread's static prompt names it an interactive agent.
 * Concurrent requests then consume the entry meant for them, in any arrival
 * order. The phrases are coupled to the prompt wording — if a prompt reword
 * breaks a test, pick phrases still unique to each side.
 */
export const AGENT_SYSTEM_PHRASE = 'agent for Claude Code'
export const MAIN_SYSTEM_PHRASE = 'interactive agent'

function route(
  systemPhrase: string,
  response: MockResponse,
): QueueSelectorEntry {
  return {
    selector: body => JSON.stringify(body.system ?? '').includes(systemPhrase),
    response,
  }
}

export const forAgent = (response: MockResponse) =>
  route(AGENT_SYSTEM_PHRASE, response)
export const forMain = (response: MockResponse) =>
  route(MAIN_SYSTEM_PHRASE, response)
