/**
 * Unit tests: tool catalog scope partitioning (which catalog directory a
 * server renders into) and the project catalog path helpers.
 */
import { describe, test, expect } from 'bun:test'
import type { Tool } from '../../src/Tool.js'
import type { MCPServerConnection } from '../../src/services/mcp/types.js'
import {
  catalogKeyForPath,
  partitionToolsByCatalogDir,
  knownServersByCatalogDir,
  subsetDescriptions,
  projectCatalogDir,
  projectCatalogStatePath,
} from '../../src/services/toolCatalog/scopes.js'

function fakeMcpTool(name: string, server: string): Tool {
  return {
    name,
    isMcp: true,
    mcpInfo: { serverName: server, toolName: name.slice(server.length + 3) },
    inputJSONSchema: { type: 'object', properties: {} },
    prompt: async () => `description of ${name}`,
    isReadOnly: () => false,
    isDestructive: () => false,
    isOpenWorld: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  } as unknown as Tool
}

function fakeClient(name: string, scope: string): MCPServerConnection {
  return {
    name,
    type: 'pending',
    config: { scope },
  } as unknown as MCPServerConnection
}

describe('catalog scope partitioning', () => {
  test('project and local scopes render into the project dir', () => {
    const tools = [
      fakeMcpTool('mcp__oliver__list', 'oliver'),
      fakeMcpTool('mcp__local__x', 'local-srv'),
    ]
    const clients = [
      fakeClient('oliver', 'project'),
      fakeClient('local-srv', 'local'),
    ]
    const p = partitionToolsByCatalogDir(tools, clients)
    expect(p.project.map(t => t.name)).toEqual([
      'mcp__oliver__list',
      'mcp__local__x',
    ])
    expect(p.user).toEqual([])
    expect(p.projectDirActive).toBe(true)
  })

  test('user, dynamic, claudeai, and unknown scopes render into the user dir', () => {
    const tools = [
      fakeMcpTool('mcp__slack__send', 'slack'),
      fakeMcpTool('mcp__agent-browser__open', 'agent-browser'),
      fakeMcpTool('mcp__weird__x', 'weird'),
    ]
    const clients = [
      fakeClient('slack', 'user'),
      fakeClient('agent-browser', 'dynamic'),
    ]
    const p = partitionToolsByCatalogDir(tools, clients)
    expect(p.user.map(t => t.name)).toEqual([
      'mcp__slack__send',
      'mcp__agent-browser__open',
      'mcp__weird__x',
    ])
    expect(p.project).toEqual([])
    expect(p.projectDirActive).toBe(false)
  })

  test('projectDirActive reflects configured servers, not connectivity', () => {
    // A project server that is pending (no tools rendered yet) still claims
    // its project dir, so its files are never re-homed to the user dir.
    const p = partitionToolsByCatalogDir([], [fakeClient('oliver', 'project')])
    expect(p.project).toEqual([])
    expect(p.projectDirActive).toBe(true)
  })

  test('knownServersByCatalogDir splits by scope across all connection states', () => {
    const clients = [
      fakeClient('oliver', 'project'),
      fakeClient('slack', 'user'),
      fakeClient('agent-browser', 'dynamic'),
      fakeClient('local-srv', 'local'),
    ]
    const known = knownServersByCatalogDir(clients)
    expect([...known.project].sort()).toEqual(['local-srv', 'oliver'])
    expect([...known.user].sort()).toEqual(['agent-browser', 'slack'])
  })

  test('subsetDescriptions keeps only the subset servers', () => {
    const descriptions = new Map([
      ['oliver', 'o'],
      ['slack', 's'],
    ])
    const sub = subsetDescriptions(descriptions, [
      fakeMcpTool('mcp__oliver__a', 'oliver'),
    ])
    expect([...sub.entries()]).toEqual([['oliver', 'o']])
  })

  test('catalogKeyForPath sanitizes path separators', () => {
    expect(catalogKeyForPath('/Users/x/my-project')).toBe('-Users-x-my-project')
  })

  test('project state file is a sibling of the project catalog dir', () => {
    expect(projectCatalogStatePath()).toBe(`${projectCatalogDir()}.json`)
  })
})
