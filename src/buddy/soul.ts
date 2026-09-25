import { queryHaiku } from '../services/api/claude.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { safeParseJSON } from '../utils/json.js'
import { extractTextContent } from '../utils/messages.js'
import { asSystemPrompt } from '../utils/systemPromptType.js'
import { hashString, mulberry32 } from './companion.js'
import type { CompanionBones, CompanionSoul, StatName } from './types.js'
import { RARITY_STARS, STAT_NAMES } from './types.js'

const FALLBACK_NAMES = [
  'Pip',
  'Momo',
  'Byte',
  'Kiwi',
  'Sprocket',
  'Nori',
  'Widget',
  'Tofu',
  'Pixel',
  'Biscuit',
  'Junction',
  'Cricket',
  'Pixelina',
  'Sir Rolls',
  'Miso',
  'Gremlin',
]

const FALLBACK_PERSONALITIES: Record<StatName, string> = {
  DEBUGGING: 'quietly fixes things before anyone notices they were broken',
  PATIENCE: 'watches the build spin for ten minutes without flinching',
  CHAOS: 'presses buttons to see what happens, usually on purpose',
  WISDOM: 'offers one dry sentence per hour and it is always the right one',
  SNARK: 'loves the code, never says so',
}

function pickSome<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!
}

function fallbackSoul(bones: CompanionBones, seed: number): CompanionSoul {
  const rng = mulberry32(hashString(`${bones.species}:${seed}`))
  const peak = STAT_NAMES.reduce((a, b) =>
    bones.stats[a] >= bones.stats[b] ? a : b,
  )
  return {
    name: pickSome(rng, FALLBACK_NAMES),
    personality: FALLBACK_PERSONALITIES[peak],
  }
}

/**
 * Invent a name and personality for an unhatched companion. Deterministic
 * bones + inspiration seed go in, soul comes out. Falls back to a seeded
 * pick from static lists when the utility model fails, so hatching never
 * dead-ends on a network error.
 */
export async function generateSoul(
  bones: CompanionBones,
  inspirationSeed: number,
  rerollNote: string | undefined,
  signal: AbortSignal,
): Promise<CompanionSoul> {
  const stats = STAT_NAMES.map(n => `${n} ${bones.stats[n]}`).join(', ')
  const userPrompt = [
    `Species: ${bones.species}`,
    `Rarity: ${bones.rarity} ${RARITY_STARS[bones.rarity]}`,
    `Hat: ${bones.hat}${bones.shiny ? ' (shiny)' : ''}`,
    `Stats: ${stats}`,
    `Inspirational seed: ${inspirationSeed}`,
    rerollNote ? `Try something different: ${rerollNote}` : undefined,
  ]
    .filter(line => line !== undefined)
    .join('\n')

  try {
    const result = await queryHaiku({
      systemPrompt: asSystemPrompt([
        'You name a tiny terminal companion — an ASCII creature that will sit beside the user\'s prompt box. From the bones below, invent a name (one word, capitalized, max 12 chars) and a one-sentence personality (max 140 chars) that fits the stats: lean into the peak stat, nod to the dump stat. The personality should describe how it behaves, not repeat the stat names. Be playful and specific. Return JSON with "name" and "personality" fields.',
      ]),
      userPrompt,
      outputFormat: {
        type: 'json_schema',
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            personality: { type: 'string' },
          },
          required: ['name', 'personality'],
          additionalProperties: false,
        },
      },
      signal,
      options: {
        querySource: 'buddy_hatch',
        agents: [],
        isNonInteractiveSession: false,
        hasAppendSystemPrompt: false,
      },
    })

    const content = extractTextContent(result.message.content)
    const parsed = safeParseJSON(content)
    if (
      parsed &&
      typeof parsed === 'object' &&
      'name' in parsed &&
      'personality' in parsed &&
      typeof (parsed as { name: unknown }).name === 'string' &&
      typeof (parsed as { personality: unknown }).personality === 'string'
    ) {
      const name = (parsed as { name: string }).name.trim().slice(0, 24)
      const personality = (parsed as { personality: string }).personality
        .trim()
        .slice(0, 200)
      if (name && personality) return { name, personality }
    }
    logForDebugging(
      `generateSoul: unparseable response: ${content.slice(0, 200)}`,
      {
        level: 'error',
      },
    )
  } catch (error) {
    logForDebugging(`generateSoul failed: ${errorMessage(error)}`, {
      level: 'error',
    })
  }
  return fallbackSoul(bones, inspirationSeed)
}
