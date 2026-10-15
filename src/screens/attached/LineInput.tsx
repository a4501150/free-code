import React, { useState } from 'react'
import { Box, Text, useInput } from '../../ink.js'

/**
 * A single-line text field for the trays, local to this screen.
 *
 * The REPL's TextInput is a voice/waveform/paste stack behind providers an
 * attached viewer does not mount; the trays need typing, backspace, and
 * submit, and nothing more.
 */
export function LineInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
  isActive = true,
}: {
  value: string
  onChange: (next: string) => void
  onSubmit: (value: string) => void
  onCancel?: () => void
  placeholder?: string
  isActive?: boolean
}): React.ReactNode {
  const [caretBlink, setCaretBlink] = useState(false)
  React.useEffect(() => {
    if (!isActive) return
    const timer = setInterval(() => setCaretBlink(b => !b), 600)
    timer.unref?.()
    return () => clearInterval(timer)
  }, [isActive])

  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit(value)
        return
      }
      if (key.escape) {
        onCancel?.()
        return
      }
      if (key.backspace || key.delete) {
        onChange(value.slice(0, -1))
        return
      }
      if (key.ctrl || key.meta) return
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) {
        return
      }
      if (input) {
        // A paste can carry newlines; keep the field single-line.
        onChange(value + input.replace(/\s*\n\s*/g, ' '))
      }
    },
    { isActive },
  )

  return (
    <Box>
      <Text>{value}</Text>
      {value === '' && placeholder ? <Text dimColor>{placeholder}</Text> : null}
      <Text inverse={caretBlink}> </Text>
    </Box>
  )
}
