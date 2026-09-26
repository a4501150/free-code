import { afterEach, describe, expect, test } from 'bun:test'
import type { ToolUseContext } from '../../src/Tool.js'
import {
  startUserInputAttachmentPrefetch,
  takeUserInputAttachmentPrefetch,
} from '../../src/utils/attachments.js'

function fakeContext(): ToolUseContext {
  return {
    abortController: new AbortController(),
    options: {
      agentDefinitions: { activeAgents: [] },
      mcpClients: [],
      mcpResources: {},
    },
    getAppState: () => ({ toolPermissionContext: {} }),
    nestedMemoryAttachmentTriggers: new Set<string>(),
  } as unknown as ToolUseContext
}

const makeContext = () => fakeContext()

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

afterEach(() => {
  // Drain any handle left by a failed assertion so module-level state
  // doesn't leak across tests (single shared bun test process).
  takeUserInputAttachmentPrefetch('__drain__')
})

describe('user input attachment prefetch', () => {
  test('non-@ drafts never schedule a prefetch', async () => {
    startUserInputAttachmentPrefetch(
      'just words @nothing',
      makeContext,
      [],
      'model',
    )
    // '@' present but no real mention still schedules; the no-@ cases skip:
    takeUserInputAttachmentPrefetch('just words @nothing')

    startUserInputAttachmentPrefetch('plain text', makeContext, [], 'model')
    expect(takeUserInputAttachmentPrefetch('plain text')).toBeUndefined()

    startUserInputAttachmentPrefetch('/cmd @f', makeContext, [], 'model')
    expect(takeUserInputAttachmentPrefetch('/cmd @f')).toBeUndefined()
  })

  test('@ drafts prefetch after the debounce and are taken by exact input', async () => {
    startUserInputAttachmentPrefetch(
      'look at @does-not-exist.ts',
      makeContext,
      [],
      'model',
    )
    // Still inside the debounce window: nothing started yet.
    expect(takeUserInputAttachmentPrefetch('look at @does-not-exist.ts')).toBe(
      undefined,
    )

    startUserInputAttachmentPrefetch(
      'look at @does-not-exist.ts',
      makeContext,
      [],
      'model',
    )
    await sleep(250)
    const handle = takeUserInputAttachmentPrefetch('look at @does-not-exist.ts')
    expect(handle).toBeDefined()
    // Missing file: resolves empty rather than rejecting.
    expect(await handle!.promise).toEqual([])
    // Single-slot: consumed handles are not re-taken.
    expect(
      takeUserInputAttachmentPrefetch('look at @does-not-exist.ts'),
    ).toBeUndefined()
  })

  test('a changed draft aborts the stale prefetch and takes nothing', async () => {
    startUserInputAttachmentPrefetch(
      'early @does-not-exist.ts',
      makeContext,
      [],
      'model',
    )
    await sleep(250)
    // Draft changed: the stored handle is dropped (and aborted), and the
    // caller recomputes fresh for the actual submitted text.
    expect(takeUserInputAttachmentPrefetch('different draft')).toBeUndefined()
    expect(
      takeUserInputAttachmentPrefetch('early @does-not-exist.ts'),
    ).toBeUndefined()
  })
})
