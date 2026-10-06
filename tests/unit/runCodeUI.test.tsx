/**
 * Frame-level rendering tests for the RunCode card, the nested child-tool
 * progress rows, and the result/error lines — the visual contract that the
 * wire-level e2e does not cover.
 */
import { describe, expect, test } from 'bun:test'
import * as React from 'react'
import { z } from 'zod/v4'
import type { Tool } from '../../src/Tool.js'
import { RunCodeTool } from '../../src/tools/RunCodeTool/RunCodeTool.js'
import {
  renderToolResultMessage,
  renderToolUseErrorMessage,
  renderToolUseProgressMessage,
} from '../../src/tools/RunCodeTool/UI.js'
import {
  createAssistantMessage,
  createProgressMessage,
  createUserMessage,
} from '../../src/utils/messages.js'
import type { ProgressMessage } from '../../src/types/message.js'
import type { RunCodeProgress } from '../../src/types/tools.js'
import { renderToString } from '../../src/utils/staticRender.js'
import { AppStateProvider } from '../../src/state/AppState.js'

function mcpTool(name: string, facingName: string): Tool {
  return {
    name,
    isMcp: true,
    mcpInfo: { serverName: 'srv', toolName: facingName },
    inputSchema: z.object({}).passthrough(),
    userFacingName: () => facingName,
  } as unknown as Tool
}

const tools = [
  RunCodeTool as unknown as Tool,
  mcpTool('mcp__srv__echo', 'echo'),
]

function childToolUse(id: string, name: string, input: unknown) {
  return createAssistantMessage({
    content: [{ type: 'tool_use', id, name, input } as never],
  })
}

function progressFor(
  toolUseId: string,
  message: ReturnType<typeof childToolUse>,
): ProgressMessage<RunCodeProgress> {
  return createProgressMessage({
    toolUseID: `emit_${toolUseId}`,
    parentToolUseID: 'rc1',
    data: { type: 'runcode_progress', message },
  }) as ProgressMessage<RunCodeProgress>
}

function wrap(node: React.ReactNode) {
  return <AppStateProvider>{node}</AppStateProvider>
}

describe('RunCode card display', () => {
  test('title labels the collapsed row', async () => {
    const label = RunCodeTool.renderToolUseMessage({
      code: 'const x = 1;',
      title: 'crawl two pages',
    })
    const frame = await renderToString(wrap(label))
    expect(frame).toContain('crawl two pages')
  })

  test('without a title, the first code line labels the row', async () => {
    const label = RunCodeTool.renderToolUseMessage({
      code: '\n// fetch and summarize\nconst x = 1;',
    })
    const frame = await renderToString(wrap(label))
    expect(frame).toContain('fetch and summarize')
  })
})

describe('RunCode nested progress rows', () => {
  test('collapsed pending calls render one lightweight line per call', async () => {
    const progress = [
      progressFor('a', childToolUse('a', 'mcp__srv__echo', { msg: 'hi' })),
    ]
    const frame = await renderToString(
      wrap(renderToolUseProgressMessage(progress, { tools, verbose: false })),
    )
    expect(frame).toContain('calling echo…')
    // Args stay out of the collapsed rows; verbose replay shows them.
    expect(frame).not.toContain('msg:')
  })

  test('resolved calls show the name with a result mark', async () => {
    const progress = [
      progressFor('a', childToolUse('a', 'mcp__srv__echo', { msg: 'hi' })),
      progressFor(
        'a',
        createUserMessage({
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'a',
              content: 'echo:hi',
            } as never,
          ],
        }),
      ),
    ]
    const frame = await renderToString(
      wrap(renderToolUseProgressMessage(progress, { tools, verbose: false })),
    )
    // The pending "calling…" line is replaced by the resolved row.
    expect(frame).not.toContain('calling echo…')
    expect(frame).toContain('echo')
  })

  test('verbose mode replays child tool_use messages as nested tool rows', async () => {
    const progress = [
      progressFor('a', childToolUse('a', 'mcp__srv__echo', { msg: 'hi' })),
    ]
    const frame = await renderToString(
      wrap(renderToolUseProgressMessage(progress, { tools, verbose: true })),
    )
    // Condensed nested rows render like direct tool rows: bullet, name, args.
    expect(frame).toContain('echo(msg:')
  })

  test('non-verbose mode shows the tail and counts the hidden rows', async () => {
    const progress = Array.from({ length: 7 }, (_, i) =>
      progressFor(
        `id${i}`,
        childToolUse(`id${i}`, 'mcp__srv__echo', { msg: String(i) }),
      ),
    )
    const frame = await renderToString(
      wrap(renderToolUseProgressMessage(progress, { tools, verbose: false })),
    )
    expect(frame).toContain('+2 more tool uses')
  })

  test('no progress yet renders the running placeholder', async () => {
    const frame = await renderToString(
      wrap(renderToolUseProgressMessage([], { tools, verbose: false })),
    )
    expect(frame).toContain('Running script')
  })

  test('running header counts calls and flags failures', async () => {
    const progress = [
      progressFor('a', childToolUse('a', 'mcp__srv__echo', { msg: 'hi' })),
    ]
    const frame = await renderToString(
      wrap(renderToolUseProgressMessage(progress, { tools, verbose: false })),
    )
    expect(frame).toContain('Running script')
    expect(frame).toContain('1 call')
  })

  test('a failed call row survives the tail trim', async () => {
    const progress = [
      progressFor(
        'old',
        childToolUse('old', 'mcp__srv__echo', { msg: 'first' }),
      ),
      progressFor(
        'old',
        createUserMessage({
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'old',
              is_error: true,
              content: 'inner exploded',
            } as never,
          ],
        }),
      ),
      ...Array.from({ length: 7 }, (_, i) =>
        progressFor(
          `id${i}`,
          childToolUse(`id${i}`, 'mcp__srv__echo', { msg: String(i) }),
        ),
      ),
    ]
    const frame = await renderToString(
      wrap(renderToolUseProgressMessage(progress, { tools, verbose: false })),
    )
    // The errored row is first in history yet still rendered; only the
    // remaining rows are trimmed to the tail.
    expect(frame).toContain('inner exploded')
    expect(frame).toContain('1 call failed')
    expect(frame).toContain('+3 more tool uses')
  })
})

describe('RunCode result and error lines', () => {
  test('result lists each called method, failures with their headline', async () => {
    const node = renderToolResultMessage({
      segments: [
        { name: 'mcp__srv__echo', ok: true, output: 'echo:hi' },
        { name: 'mcp__srv__boom', ok: false, error: 'inner exploded\n…' },
      ],
      logs: 'in-script\ngot echo:hi',
    })
    const frame = await renderToString(wrap(node))
    // One line per call, bare names (no mcp__srv__ prefix), error headline.
    expect(frame).toContain('echo')
    expect(frame).toContain('boom')
    expect(frame).toContain('inner exploded')
    expect(frame).not.toContain('mcp__srv__')
    expect(frame).toContain('2 logged lines')
  })

  test('collapsed result trims to the tail; verbose keeps every call', async () => {
    const segments = Array.from({ length: 7 }, (_, i) => ({
      name: `mcp__srv__echo${i}`,
      ok: true,
      output: 'x',
    }))
    const collapsed = await renderToString(
      wrap(renderToolResultMessage({ segments, logs: '' })),
    )
    expect(collapsed).not.toContain('echo0')
    expect(collapsed).toContain('echo6')
    expect(collapsed).toContain('+2 more calls')
    const verbose = await renderToString(
      wrap(
        renderToolResultMessage({ segments, logs: '' }, [], { verbose: true }),
      ),
    )
    expect(verbose).toContain('echo0')
  })

  test('logs-only script reports the logged lines, no calls reports none', async () => {
    const logsFrame = await renderToString(
      wrap(renderToolResultMessage({ segments: [], logs: 'console only' })),
    )
    expect(logsFrame).toContain('1 logged line')
    const emptyFrame = await renderToString(
      wrap(renderToolResultMessage({ segments: [], logs: '' })),
    )
    expect(emptyFrame).toContain('no tool calls')
  })

  test('error frame replays the nested rows above the error line', async () => {
    const progress = [
      progressFor('a', childToolUse('a', 'mcp__srv__echo', { msg: 'hi' })),
    ]
    const node = renderToolUseErrorMessage('Script interrupted.', {
      progressMessagesForMessage: progress,
      tools,
      verbose: false,
    })
    const frame = await renderToString(wrap(node))
    expect(frame).toContain('echo')
  })

  test('collapsed error shows the headline, not the payload echo', async () => {
    const mcpError = [
      'Error: mcp__srv__browser_navigate: ### Error',
      'No browser instance "### Result',
      '{',
      '  "instance_id": "inst_c07a6808",',
      '  "profile": "default",',
      '  "headless": true,',
      '  "fingerprint": null,',
      '  "tabs": 1,',
      '"current_url": "about:blank",',
      '"extra": 1,',
      '"more": 2',
      '}',
    ].join('\n')
    const collapsed = await renderToString(
      wrap(
        renderToolUseErrorMessage(mcpError, {
          progressMessagesForMessage: [],
          tools,
          verbose: false,
        }),
      ),
    )
    expect(collapsed).toContain('browser_navigate')
    expect(collapsed).toContain('No browser instance')
    expect(collapsed).not.toContain('instance_id')
    expect(collapsed).not.toContain('### Error')
    const expanded = await renderToString(
      wrap(
        renderToolUseErrorMessage(mcpError, {
          progressMessagesForMessage: [],
          tools,
          verbose: true,
        }),
      ),
    )
    expect(expanded).toContain('instance_id')
  })
})
