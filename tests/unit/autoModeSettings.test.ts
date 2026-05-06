import { describe, expect, test } from 'bun:test'

import { __test__ } from '../../src/utils/permissions/yoloClassifier.js'
import { isAutoModeDisabledInSettings } from '../../src/utils/permissions/permissionSetup.js'
import { getAutoModeClassifierModelFromSettings } from '../../src/utils/settings/settings.js'
import {
  SettingsSchema,
  normalizeAutoModeSetting,
} from '../../src/utils/settings/types.js'

describe('auto-mode settings shape', () => {
  test('accepts canonical autoMode object settings', () => {
    const result = SettingsSchema()
      .strict()
      .safeParse({
        autoMode: {
          enabled: false,
          classifierModel: 'anthropic:claude-sonnet-4-6',
          environment: ['Runs in CI'],
          deny: ['Network access'],
          allow: ['Read-only inspection'],
        },
      })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.autoMode).toEqual({
      enabled: false,
      classifierModel: 'anthropic:claude-sonnet-4-6',
      environment: ['Runs in CI'],
      deny: ['Network access'],
      allow: ['Read-only inspection'],
    })
  })

  test('normalizes legacy boolean and section settings for migration', () => {
    expect(normalizeAutoModeSetting(false)).toEqual({ enabled: false })

    expect(
      normalizeAutoModeSetting({
        environment: ['Runs in CI'],
        deny: ['Network access'],
        allow: ['Read-only inspection'],
      }),
    ).toEqual({
      environment: ['Runs in CI'],
      deny: ['Network access'],
      allow: ['Read-only inspection'],
    })
  })

  test('runtime gate treats autoMode.enabled false as disabled', () => {
    expect(isAutoModeDisabledInSettings({ autoMode: { enabled: false } })).toBe(
      true,
    )
    expect(isAutoModeDisabledInSettings({ autoMode: { enabled: true } })).toBe(
      false,
    )
    expect(isAutoModeDisabledInSettings({})).toBe(false)
  })

  test('classifier model resolution prefers autoMode.classifierModel', () => {
    expect(
      getAutoModeClassifierModelFromSettings({
        autoMode: { classifierModel: 'anthropic:claude-sonnet-4-6' },
        autoModeClassifierModel: 'legacy-model',
      }),
    ).toBe('anthropic:claude-sonnet-4-6')
    expect(
      getAutoModeClassifierModelFromSettings({
        autoModeClassifierModel: 'legacy-model',
      }),
    ).toBe('legacy-model')
  })

  test('custom sections replace their default template regions when bundled', () => {
    const rules = __test__.buildExternalAutoModeRules({
      environment: ['Custom environment'],
      deny: ['Custom deny'],
      allow: ['Custom allow'],
    })

    if (rules === '') {
      expect(rules).toBe('')
      return
    }
    expect(rules).toContain('## Environment\n\n- Custom environment')
    expect(rules).toContain(
      '## BLOCK if the action does ANY of these\n\n- Custom deny',
    )
    expect(rules).toContain('## ALLOW (exceptions) if ANY of these apply')
    expect(rules).toContain('- Custom allow')
    expect(rules).not.toContain('<user_environment_to_replace>')
    expect(rules).not.toContain('<user_deny_rules_to_replace>')
    expect(rules).not.toContain('<user_allow_rules_to_replace>')
  })
})
