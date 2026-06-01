/**
 * Unit tests: Codex adapter parallel-tool-call event handling.
 *
 * Verifies that parallel function calls in the OpenAI Responses API
 * produce N distinct tool_use content blocks at distinct indices with
 * correct names and arguments.
 */

import { describe, expect, test } from 'bun:test'
import { createCodexFetch } from '../../src/services/api/codex-fetch-adapter.js'

type SSEEvent = { event: string; data: Record<string, unknown> }

function parseAnthropicSSE(text: string): SSEEvent[] {
  const events: SSEEvent[] = []
  for (const chunk of text.split('\n\n')) {
    if (!chunk.trim()) continue
    let eventName = ''
    let dataLine = ''
    for (const line of chunk.split('\n')) {
      if (line.startsWith('event: ')) eventName = line.slice(7).trim()
      else if (line.startsWith('data: ')) dataLine = line.slice(6)
    }
    if (!eventName || !dataLine) continue
    try {
      events.push({ event: eventName, data: JSON.parse(dataLine) })
    } catch {
      /* skip */
    }
  }
  return events
}

async function drainToString(
  body: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let out = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    out += decoder.decode(value, { stream: true })
  }
  out += decoder.decode()
  return out
}

async function runAdapter(responsesSSE: string): Promise<SSEEvent[]> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () =>
    new Response(responsesSSE, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })) as unknown as typeof globalThis.fetch
  try {
    const adapterFetch = createCodexFetch({
      accessToken: 'unused',
      baseUrl: 'http://localhost',
      getSessionId: () => 'test-session',
    })
    const response = await adapterFetch('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [
          {
            name: 'bash',
            description: 'shell',
            input_schema: {
              type: 'object',
              properties: { cmd: { type: 'string' } },
            },
          },
          {
            name: 'read_file',
            description: 'read',
            input_schema: {
              type: 'object',
              properties: { path: { type: 'string' } },
            },
          },
        ],
      }),
    })
    return parseAnthropicSSE(await drainToString(response.body!))
  } finally {
    globalThis.fetch = originalFetch
  }
}

interface ToolUseBlock {
  index: number
  id: string
  name: string
  input: string
}

function extractToolUseBlocks(events: SSEEvent[]): ToolUseBlock[] {
  // For each tool_use content_block_start, collect its index, id, name,
  // and concatenated input_json_delta partial_json strings until its stop.
  const result: ToolUseBlock[] = []
  const inFlight = new Map<number, ToolUseBlock>()
  for (const evt of events) {
    if (evt.event === 'content_block_start') {
      const block = evt.data.content_block as Record<string, unknown>
      if (block?.type === 'tool_use') {
        const idx = evt.data.index as number
        inFlight.set(idx, {
          index: idx,
          id: (block.id as string) || '',
          name: (block.name as string) || '',
          input: '',
        })
      }
    } else if (evt.event === 'content_block_delta') {
      const idx = evt.data.index as number
      const delta = evt.data.delta as Record<string, unknown>
      if (delta?.type === 'input_json_delta' && inFlight.has(idx)) {
        inFlight.get(idx)!.input += (delta.partial_json as string) || ''
      }
    } else if (evt.event === 'content_block_stop') {
      const idx = evt.data.index as number
      if (inFlight.has(idx)) {
        result.push(inFlight.get(idx)!)
        inFlight.delete(idx)
      }
    }
  }
  return result
}

describe('Codex adapter: parallel tool calls', () => {
  test('canonical OpenAI ordering — each item full lifecycle before next opens — emits 3 distinct tool_use blocks', async () => {
    // This is the upstream OpenAI Responses shape. The eager-close branch
    // and stale-.done branch must remain inert here.
    const responsesSSE = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"resp_y"}}',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"bash","call_id":"fcA","arguments":""}}',
      '',
      'event: response.function_call_arguments.delta',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fcA","delta":"{\\"cmd\\":\\"date\\"}"}',
      '',
      'event: response.function_call_arguments.done',
      'data: {"type":"response.function_call_arguments.done","item_id":"fcA","arguments":"{\\"cmd\\":\\"date\\"}"}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"bash","call_id":"fcA","arguments":"{\\"cmd\\":\\"date\\"}"}}',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"bash","call_id":"fcB","arguments":""}}',
      '',
      'event: response.function_call_arguments.delta',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fcB","delta":"{\\"cmd\\":\\"whoami\\"}"}',
      '',
      'event: response.function_call_arguments.done',
      'data: {"type":"response.function_call_arguments.done","item_id":"fcB","arguments":"{\\"cmd\\":\\"whoami\\"}"}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"bash","call_id":"fcB","arguments":"{\\"cmd\\":\\"whoami\\"}"}}',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"read_file","call_id":"fcC","arguments":""}}',
      '',
      'event: response.function_call_arguments.delta',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fcC","delta":"{\\"path\\":\\"/x\\"}"}',
      '',
      'event: response.function_call_arguments.done',
      'data: {"type":"response.function_call_arguments.done","item_id":"fcC","arguments":"{\\"path\\":\\"/x\\"}"}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"read_file","call_id":"fcC","arguments":"{\\"path\\":\\"/x\\"}"}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":10}}}',
      '',
      '',
    ].join('\n')

    const events = await runAdapter(responsesSSE)
    const toolBlocks = extractToolUseBlocks(events)

    expect(toolBlocks).toHaveLength(3)
    expect(new Set(toolBlocks.map(b => b.index)).size).toBe(3)
    expect(toolBlocks[0]).toMatchObject({ id: 'fcA', name: 'bash' })
    expect(toolBlocks[1]).toMatchObject({ id: 'fcB', name: 'bash' })
    expect(toolBlocks[2]).toMatchObject({ id: 'fcC', name: 'read_file' })
    expect(JSON.parse(toolBlocks[0].input)).toEqual({ cmd: 'date' })
    expect(JSON.parse(toolBlocks[1].input)).toEqual({ cmd: 'whoami' })
    expect(JSON.parse(toolBlocks[2].input)).toEqual({ path: '/x' })
  })

  test('single tool call (no parallel) still works under both orderings', async () => {
    const responsesSSE = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"bash","call_id":"fcSolo","arguments":""}}',
      '',
      'event: response.function_call_arguments.delta',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fcSolo","delta":"{\\"cmd\\":\\"ls\\"}"}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"bash","call_id":"fcSolo","arguments":"{\\"cmd\\":\\"ls\\"}"}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":3}}}',
      '',
      '',
    ].join('\n')

    const events = await runAdapter(responsesSSE)
    const toolBlocks = extractToolUseBlocks(events)
    expect(toolBlocks).toHaveLength(1)
    expect(toolBlocks[0]).toMatchObject({ id: 'fcSolo', name: 'bash' })
    expect(JSON.parse(toolBlocks[0].input)).toEqual({ cmd: 'ls' })
  })

  test('argument deltas route by item_id after another function call is added', async () => {
    const responsesSSE = [
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"bash","call_id":"fc1","arguments":""}}',
      '',
      'event: response.output_item.added',
      'data: {"type":"response.output_item.added","item":{"type":"function_call","name":"read_file","call_id":"fc2","arguments":""}}',
      '',
      'event: response.function_call_arguments.delta',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc1","delta":"{\\"cmd\\":\\"date\\"}"}',
      '',
      'event: response.function_call_arguments.delta',
      'data: {"type":"response.function_call_arguments.delta","item_id":"fc2","delta":"{\\"path\\":\\"/x\\"}"}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"bash","call_id":"fc1","arguments":""}}',
      '',
      'event: response.output_item.done',
      'data: {"type":"response.output_item.done","item":{"type":"function_call","name":"read_file","call_id":"fc2","arguments":""}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":3}}}',
      '',
      '',
    ].join('\n')

    const events = await runAdapter(responsesSSE)
    const toolBlocks = extractToolUseBlocks(events)
    expect(toolBlocks).toHaveLength(2)
    expect(toolBlocks[0]).toMatchObject({ id: 'fc1', name: 'bash' })
    expect(toolBlocks[1]).toMatchObject({ id: 'fc2', name: 'read_file' })
    expect(JSON.parse(toolBlocks[0].input)).toEqual({ cmd: 'date' })
    expect(JSON.parse(toolBlocks[1].input)).toEqual({ path: '/x' })
  })

})
