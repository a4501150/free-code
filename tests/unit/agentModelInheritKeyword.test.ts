import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  getAgentModel,
  isModelInheritKeyword,
} from '../../src/utils/model/agent.js'
import { getRuntimeMainLoopModel } from '../../src/utils/model/model.js'
import {
  initProviderRegistry,
  resetProviderRegistry,
} from '../../src/utils/model/providerRegistry.js'

describe('isModelInheritKeyword', () => {
  test('accepts the keywords case- and whitespace-insensitively', () => {
    for (const kw of ['inherit', 'Inherit', '  default  ', 'PARENT']) {
      expect(isModelInheritKeyword(kw)).toBe(true)
    }
  })

  test('rejects model IDs', () => {
    for (const id of [
      'anthropic:claude-sonnet-4-5',
      'claude-opus-4-1',
      'inherit-ish',
      'sonnet',
    ]) {
      expect(isModelInheritKeyword(id)).toBe(false)
    }
  })
})

describe('getAgentModel with inherit keywords', () => {
  // An unconfigured registry: a configured defaultSubagentModel (real user
  // settings can set one) intentionally wins over everything below it and
  // would mask the keyword branch. A null instance won't do — it lazily
  // rebuilds from freecode.json — so install an explicitly empty one.
  beforeEach(() => initProviderRegistry({}))
  afterEach(() => resetProviderRegistry())

  const parent = 'anthropic:claude-sonnet-4-5'
  // Computed inside each test: the runtime model resolves through the
  // provider registry / user settings, which initialize lazily and can
  // legitimately resolve differently at import time than at test time.
  const expectedRuntimeModel = () =>
    getRuntimeMainLoopModel({
      permissionMode: 'default',
      mainLoopModel: parent,
      exceeds200kTokens: false,
    })

  for (const keyword of ['inherit', 'default', 'parent']) {
    test(`"${keyword}" as a tool-specified model resolves to the parent`, () => {
      expect(getAgentModel(undefined, parent, keyword)).toBe(
        expectedRuntimeModel(),
      )
    })

    test(`"${keyword}" overrides a model set in the agent definition`, () => {
      // Explicit inherit must beat the agent definition's own model.
      expect(getAgentModel('anthropic:claude-opus-4-1', parent, keyword)).toBe(
        expectedRuntimeModel(),
      )
    })
  }
})
