import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as React from 'react'
import { SpinnerWithVerb } from '../../src/components/Spinner.js'
import { AppStateProvider } from '../../src/state/AppState.js'
import {
  initProviderRegistry,
  resetProviderRegistry,
} from '../../src/utils/model/providerRegistry.js'
import type { ProviderConfig } from '../../src/utils/settings/types.js'
import { renderToAnsiString } from '../../src/utils/staticRender.js'

// The spinner resolves the main-loop model for its effort suffix; the
// shared-process suite can leave the registry empty, so pin one.
beforeEach(() => {
  const providers: Record<string, ProviderConfig> = {
    anthropic: {
      type: 'anthropic',
      baseUrl: 'http://anthropic.test',
      auth: { active: 'apiKey', apiKey: { key: 'test-key' } },
      models: [{ id: 'claude-test' }],
    },
  }
  initProviderRegistry(providers)
})
afterEach(() => resetProviderRegistry())

function makeProps() {
  return {
    mode: 'responding' as const,
    loadingStartTimeRef: { current: Date.now() },
    totalPausedMsRef: { current: 0 },
    pauseStartTimeRef: { current: null },
    responseLengthRef: { current: 400 },
    spinnerTip: 'Do the thing',
    overrideMessage: 'Reading',
    verbose: false,
  }
}

function render(): Promise<string> {
  return renderToAnsiString(
    <AppStateProvider>
      <SpinnerWithVerb {...makeProps()} />
    </AppStateProvider>,
  )
}

describe('SpinnerWithVerb', () => {
  test('renders verb and tip', async () => {
    const frame = await render()
    expect(frame).toContain('Reading')
    expect(frame).toContain('Do the thing')
  })
})
