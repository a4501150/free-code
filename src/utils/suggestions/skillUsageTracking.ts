/**
 * Skill usage tracking.
 *
 * Phase C removes skill usage operational state, so tracking is intentionally
 * disabled while preserving public exports.
 */

/**
 * Records a skill usage for ranking purposes.
 */
export function recordSkillUsage(_skillName: string): void {}

/**
 * Calculates a usage score for a skill based on frequency and recency.
 */
export function getSkillUsageScore(_skillName: string): number {
  return 0
}
