import { feature } from 'bun:bundle'
import { registerBatchSkill } from './batch.js'
import { registerDebugSkill } from './debug.js'
import { registerKeybindingsSkill } from './keybindings.js'
import { registerLoremIpsumSkill } from './loremIpsum.js'
import { registerRememberSkill } from './remember.js'
import { registerSimplifySkill } from './simplify.js'
import { registerSkillifySkill } from './skillify.js'
import { registerUpdateConfigSkill } from './updateConfig.js'
import * as verifyNs from './verify.js'
import * as dreamNs from './dream.js'
import * as hunterNs from './hunter.js'
import * as loopNs from './loop.js'
import * as runSkillGeneratorNs from './runSkillGenerator.js'

/**
 * Initialize all bundled skills.
 * Called at startup to register skills that ship with the CLI.
 *
 * To add a new bundled skill:
 * 1. Create a new file in src/skills/bundled/ (e.g., myskill.ts)
 * 2. Export a register function that calls registerBundledSkill()
 * 3. Import and call that function here
 */
export function initBundledSkills(): void {
  registerUpdateConfigSkill()
  registerKeybindingsSkill()
  if (feature('VERIFY_PLAN')) {
    verifyNs.registerVerifySkill()
  }
  registerDebugSkill()
  registerLoremIpsumSkill()
  registerSkillifySkill()
  registerRememberSkill()
  registerSimplifySkill()
  if (feature('WORKTREE_MODE')) {
    registerBatchSkill()
  }
  if (feature('KAIROS') || feature('KAIROS_DREAM')) {
    dreamNs.registerDreamSkill()
  }
  if (feature('REVIEW_ARTIFACT')) {
    hunterNs.registerHunterSkill()
  }
  if (feature('AGENT_TRIGGERS')) {
    // /loop's isEnabled delegates to isKairosCronEnabled() — same lazy
    // per-invocation pattern as the cron tools. Registered unconditionally;
    // the skill's own isEnabled callback decides visibility.
    loopNs.registerLoopSkill()
  }
  if (feature('RUN_SKILL_GENERATOR')) {
    runSkillGeneratorNs.registerRunSkillGeneratorSkill()
  }
}
