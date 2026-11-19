import React from 'react'
import { Box, Text, useInput } from '../ink.js'
import {
  getSinglePtyHandle,
  normalizePtyOutput,
} from '../utils/shell/ptyShell.js'
import type { ShellProgress } from '../types/tools.js'
import { BashModeProgress } from './BashModeProgress.js'

type Props = {
  input: string
  progress: ShellProgress | null
  verbose: boolean
}

const normalize = normalizePtyOutput

/**
 * Live view for an interactive (PTY) bash-mode command. Keypresses are
 * forwarded to the child verbatim as raw escape sequences — the PTY's line
 * discipline does echo, canonical editing and password suppression.
 *
 * Escape (chat:cancel) and Ctrl+B (task:background) keep their app-level
 * meanings and are never forwarded: Esc tree-kills the run, Ctrl+B turns it
 * into a background task exactly like a non-interactive command.
 */
export function InteractiveBashProgress({
  input,
  progress,
  verbose,
}: Props): React.ReactNode {
  useInput((textInput, key, event) => {
    if (key.escape) return
    if (key.ctrl && textInput === 'b') return
    const sequence = event.keypress.sequence
    if (sequence) getSinglePtyHandle()?.write(sequence)
  })

  const normalizedProgress = progress
    ? {
        ...progress,
        output: normalize(progress.output),
        fullOutput: normalize(progress.fullOutput),
      }
    : null

  return (
    <>
      <BashModeProgress
        input={input}
        progress={normalizedProgress}
        verbose={verbose}
      />
      <Box marginLeft={2}>
        <Text dimColor>
          Interactive — typing goes to the command · Esc kill · Ctrl+B
          background
        </Text>
      </Box>
    </>
  )
}
