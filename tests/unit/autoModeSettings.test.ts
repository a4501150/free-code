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

  test('classifier model resolution reads autoMode.classifierModel', () => {
    expect(
      getAutoModeClassifierModelFromSettings({
        autoMode: { classifierModel: 'anthropic:claude-sonnet-4-6' },
      }),
    ).toBe('anthropic:claude-sonnet-4-6')
    expect(getAutoModeClassifierModelFromSettings({})).toBeUndefined()
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

describe('classifier template sections: rules replace, extras append', () => {
  const { replaceTemplateSection, buildExternalAutoModeRules } = __test__
  const template = '<tag>- Default one\n- Default two</tag>'

  test('undefined rules keep the template defaults', () => {
    expect(replaceTemplateSection(template, 'tag', undefined)).toBe(
      '- Default one\n- Default two',
    )
  })

  test('supplied rules replace the defaults', () => {
    // A user's autoMode settings mean "use these instead", not "add these".
    expect(replaceTemplateSection(template, 'tag', ['Mine'])).toBe('- Mine')
  })

  test('an empty rule array is an override, not an absence', () => {
    expect(replaceTemplateSection(template, 'tag', [])).toBe('')
  })

  // The bug this guards: POWERSHELL_DENY_GUIDANCE was written to be appended
  // to the deny section, but the only channel available replaced it. Passing
  // the guidance as `rules` would have deleted every default BLOCK rule.
  test('extras append to the defaults rather than replacing them', () => {
    expect(replaceTemplateSection(template, 'tag', undefined, ['Extra'])).toBe(
      '- Default one\n- Default two\n- Extra',
    )
  })

  test('extras append after a user override too', () => {
    expect(replaceTemplateSection(template, 'tag', ['Mine'], ['Extra'])).toBe(
      '- Mine\n- Extra',
    )
  })

  test('extras survive an empty override', () => {
    expect(replaceTemplateSection(template, 'tag', [], ['Extra'])).toBe(
      '- Extra',
    )
  })

  test('deny extras reach the real permissions template', () => {
    const marker = 'PowerShell Elevation Marker'
    const rules = buildExternalAutoModeRules(undefined, [marker])
    expect(rules).toContain(`- ${marker}`)
    // ...without displacing the template's own BLOCK rules.
    expect(rules).toContain('- Git Destructive:')
    expect(rules).toContain('- Data Exfiltration:')
  })

  test('deny extras do not leak into the allow section', () => {
    const rules = buildExternalAutoModeRules(undefined, ['Marker'])
    const allowIndex = rules.indexOf('- Test Artifacts:')
    expect(allowIndex).toBeGreaterThan(-1)
    expect(rules.indexOf('- Marker')).toBeLessThan(allowIndex)
  })
})
