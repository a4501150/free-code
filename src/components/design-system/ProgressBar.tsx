import React from 'react'
import { Text } from '../../ink.js'
import type { Theme } from '../../utils/theme.js'

type Props = {
  /**
   * How much progress to display, between 0 and 1 inclusive
   */
  ratio: number // [0, 1]

  /**
   * How many characters wide to draw the progress bar
   */
  width: number // how many characters wide

  /**
   * Optional color for the filled portion of the bar
   */
  fillColor?: keyof Theme

  /**
   * Optional color for the empty portion of the bar
   */
  emptyColor?: keyof Theme

  /**
   * `block` (default) draws fractional eighth-blocks on an optional
   * `emptyColor` background. `pill` draws discrete ▰/▱ glyphs, so its empty
   * cells are foreground-coloured and dim when `emptyColor` is omitted.
   */
  variant?: 'block' | 'pill'
}

const BLOCKS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█']
const PILL_FILLED = '▰'
const PILL_EMPTY = '▱'

export function ProgressBar({
  ratio: inputRatio,
  width,
  fillColor,
  emptyColor,
  variant = 'block',
}: Props): React.ReactNode {
  const ratio = Math.min(1, Math.max(0, inputRatio))

  if (variant === 'pill') {
    const filled = Math.round(ratio * width)
    return (
      <Text>
        <Text color={fillColor}>{PILL_FILLED.repeat(filled)}</Text>
        <Text color={emptyColor} dimColor={emptyColor === undefined}>
          {PILL_EMPTY.repeat(width - filled)}
        </Text>
      </Text>
    )
  }

  const whole = Math.floor(ratio * width)
  const segments = [BLOCKS[BLOCKS.length - 1]!.repeat(whole)]
  if (whole < width) {
    const remainder = ratio * width - whole
    const middle = Math.floor(remainder * BLOCKS.length)
    segments.push(BLOCKS[middle]!)

    const empty = width - whole - 1
    if (empty > 0) {
      segments.push(BLOCKS[0]!.repeat(empty))
    }
  }

  return (
    <Text color={fillColor} backgroundColor={emptyColor}>
      {segments.join('')}
    </Text>
  )
}
