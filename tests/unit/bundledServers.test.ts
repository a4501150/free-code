import { describe, expect, mock, test } from 'bun:test'

// The sidecar resolver is mocked to a fixed path — its own behavior (execPath
// candidate roots, darwin signing) is filesystem-dependent and covered by the
// e2e /mcp check, not here.
const SIDECAR = '/fake/vendor/agent-browser/arm64-darwin/agent-browser'
mock.module('../../src/utils/agentBrowserSidecar.js', () => ({
  getAgentBrowserSidecarPath: () => SIDECAR,
  prepareAgentBrowserSidecar: async () => SIDECAR,
}))

const { getBundledMcpServers } =
  await import('../../src/services/mcp/bundledServers.js')

describe('getBundledMcpServers', () => {
  test('injects the vendored server at dynamic scope when nothing manual claims the key', async () => {
    const servers = await getBundledMcpServers(new Set())
    expect(servers['agent-browser']).toEqual({
      type: 'stdio',
      command: SIDECAR,
      args: [],
      scope: 'dynamic',
    })
  })

  test('a manually-configured agent-browser entry suppresses injection', async () => {
    const servers = await getBundledMcpServers(new Set(['agent-browser']))
    expect(servers['agent-browser']).toBeUndefined()
  })

  test('no sidecar for this platform means no injection', async () => {
    const { prepareAgentBrowserSidecar } =
      await import('../../src/utils/agentBrowserSidecar.js')
    mock.module('../../src/utils/agentBrowserSidecar.js', () => ({
      getAgentBrowserSidecarPath: () => undefined,
      prepareAgentBrowserSidecar: async () => undefined,
    }))
    void prepareAgentBrowserSidecar
    const servers = await getBundledMcpServers(new Set())
    expect(Object.keys(servers)).toEqual([])
  })
})
