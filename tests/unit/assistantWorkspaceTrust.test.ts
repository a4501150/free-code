/**
 * Headless gateway children (the webui assistant above all) have no UI to
 * accept the trust dialog, so the gateway bootstrap persists trust for the
 * assistant workspace through the config module's locked state.json path.
 * These tests run with NODE_ENV=test (bun test), where the config module
 * operates on its in-memory test config — the same code paths, minus disk.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, realpath, rm, symlink } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  ensureWorkspaceTrustPersisted,
  getGlobalConfig,
  isPathTrusted,
  resetTrustDialogAcceptedCacheForTesting,
  saveProjectConfigForPath,
} from '../../src/utils/config.js'

let configDir: string
let workspace: string

beforeEach(async () => {
  resetTrustDialogAcceptedCacheForTesting()
  configDir = await mkdtemp(join(tmpdir(), 'assistant-trust-'))
  // Config keys are symlink-resolved (a child's process.cwd() is resolved by
  // the OS), so expectations must use the canonical tmpdir path — on macOS
  // the raw mkdtemp path goes through the /var → /private/var link.
  workspace = join(await realpath(configDir), 'webui', 'assistant')
})

afterEach(async () => {
  await rm(configDir, { recursive: true, force: true })
})

describe('ensureWorkspaceTrustPersisted', () => {
  test('persists a trust record keyed by the absolute path', () => {
    expect(isPathTrusted(workspace)).toBe(false)
    ensureWorkspaceTrustPersisted(workspace)
    expect(isPathTrusted(workspace)).toBe(true)
    expect(
      getGlobalConfig().projects?.[workspace]?.hasTrustDialogAccepted,
    ).toBe(true)
  })

  test('is idempotent: a second call does not touch the projects map', () => {
    ensureWorkspaceTrustPersisted(workspace)
    const projects = getGlobalConfig().projects
    ensureWorkspaceTrustPersisted(workspace)
    // The already-trusted short-circuit skips the write entirely, so the map
    // is the same object — no new record, no rewrite.
    expect(getGlobalConfig().projects).toBe(projects)
  })

  test('merges into an existing project record instead of replacing it', () => {
    saveProjectConfigForPath(workspace, current => ({
      ...current,
      allowedTools: ['Bash'],
    }))
    ensureWorkspaceTrustPersisted(workspace)
    const record = getGlobalConfig().projects?.[workspace]
    expect(record?.hasTrustDialogAccepted).toBe(true)
    expect(record?.allowedTools).toEqual(['Bash'])
  })

  test('a workspace reached through a symlink records trust under the real path', async () => {
    // The gateway daemon persists trust from an env-var config home (which
    // may traverse a symlink) while the child looks it up from its resolved
    // cwd: both must land on the same key.
    const link = join(configDir, 'homelink')
    await symlink(configDir, link)
    ensureWorkspaceTrustPersisted(join(link, 'webui', 'assistant'))
    expect(isPathTrusted(workspace)).toBe(true)
    // The record carries the canonical path, not the symlinked one.
    expect(
      getGlobalConfig().projects?.[workspace]?.hasTrustDialogAccepted,
    ).toBe(true)
  })

  test('trust on an ancestor is enough: no redundant child record', () => {
    // Trust a unique parent inside this test's temp dir (not the shared
    // tmpdir root, which would leak trust into every other temp path).
    const parent = join(configDir, 'webui')
    ensureWorkspaceTrustPersisted(parent)
    // The workspace is trusted through its parent chain already.
    expect(isPathTrusted(workspace)).toBe(true)
    ensureWorkspaceTrustPersisted(workspace)
    expect(getGlobalConfig().projects?.[workspace]).toBeUndefined()
  })
})
