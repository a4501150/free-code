import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'path'

import {
  getCwdState,
  getOriginalCwd,
  setCwdState,
  setOriginalCwd,
} from '../../src/bootstrap/state.js'
import {
  checkPathSafetyForAutoEdit,
  getClaudeSkillScope,
} from '../../src/utils/permissions/filesystem.js'
import { PROJECT_CONFIG_DIRS } from '../../src/utils/projectConfigPaths.js'
import { convertToSandboxRuntimeConfig } from '../../src/utils/sandbox/sandbox-adapter.js'

let previousOriginalCwd: string
let previousCwdState: string
const projectRoot = '/tmp/freecode-project-config-protection'

beforeEach(() => {
  previousOriginalCwd = getOriginalCwd()
  previousCwdState = getCwdState()
  setOriginalCwd(projectRoot)
  setCwdState(projectRoot)
})

afterEach(() => {
  setOriginalCwd(previousOriginalCwd)
  setCwdState(previousCwdState)
})

describe('project config path protections', () => {
  test.each(PROJECT_CONFIG_DIRS)(
    'blocks project settings files under %s',
    projectConfigDir => {
      for (const fileName of [
        'settings.json',
        'settings.local.json',
        'freecode.json',
        'freecode.local.json',
      ]) {
        const safety = checkPathSafetyForAutoEdit(
          join('/tmp/other-project', projectConfigDir, fileName),
        )

        expect(safety.safe).toBe(false)
        if (!safety.safe) {
          expect(safety.classifierApprovable).toBe(true)
        }
      }
    },
  )

  test.each(PROJECT_CONFIG_DIRS)(
    'blocks trusted project config subdirectories under %s',
    projectConfigDir => {
      for (const subdir of ['commands', 'agents', 'skills']) {
        const safety = checkPathSafetyForAutoEdit(
          join(projectRoot, projectConfigDir, subdir, 'example.md'),
        )

        expect(safety.safe).toBe(false)
        if (!safety.safe) {
          expect(safety.classifierApprovable).toBe(true)
        }
      }
    },
  )

  test('sandbox write deny list includes both project config directories', () => {
    const denyWrite = convertToSandboxRuntimeConfig({}).filesystem.denyWrite

    for (const projectConfigDir of PROJECT_CONFIG_DIRS) {
      for (const fileName of [
        'settings.json',
        'settings.local.json',
        'freecode.json',
        'freecode.local.json',
      ]) {
        expect(denyWrite).toContain(
          join(projectRoot, projectConfigDir, fileName),
        )
      }

      for (const subdir of ['commands', 'agents', 'skills']) {
        expect(denyWrite).toContain(join(projectRoot, projectConfigDir, subdir))
      }
    }
  })

  test.each(PROJECT_CONFIG_DIRS)(
    'suggests scoped skill allow rules under %s',
    projectConfigDir => {
      expect(
        getClaudeSkillScope(
          join(projectRoot, projectConfigDir, 'skills', 'reviewer', 'SKILL.md'),
        ),
      ).toEqual({
        skillName: 'reviewer',
        pattern: `/${projectConfigDir}/skills/reviewer/**`,
      })
    },
  )
})
