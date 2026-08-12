import * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { Box, Text } from '../ink.js'
import {
  BUILT_IN_OUTPUT_STYLES,
  DEFAULT_OUTPUT_STYLE_NAME,
  getAllOutputStyles,
  NO_OUTPUT_STYLE_NAME,
  type OutputStyleConfig,
  resolveOutputStyleName,
} from '../outputStyles/outputStyles.js'
import { getCwd } from '../utils/cwd.js'
import type { OptionWithDescription } from './CustomSelect/select.js'
import { Select } from './CustomSelect/index.js'
import { Dialog } from './design-system/Dialog.js'

const NO_STYLE_DESCRIPTION = 'Respond without an output style'

function sourceLabel(style: OutputStyleConfig): string {
  switch (style.source) {
    case 'built-in':
      return 'built-in'
    case 'plugin':
      return 'plugin'
    case 'userSettings':
      return 'user'
    case 'projectSettings':
      return 'project'
    case 'localSettings':
      return 'local'
    case 'flagSettings':
      return 'flag'
  }
}

function toOptions(styles: {
  [name: string]: OutputStyleConfig | null
}): OptionWithDescription[] {
  const builtInNames = Object.keys(BUILT_IN_OUTPUT_STYLES)
  const names = [
    ...builtInNames,
    ...Object.keys(styles)
      .filter(name => !builtInNames.includes(name))
      .sort(),
  ]

  return names.map(name => {
    const style = styles[name]
    if (!style) {
      return {
        label: name,
        value: name,
        description: NO_STYLE_DESCRIPTION,
      }
    }
    return {
      label: name === DEFAULT_OUTPUT_STYLE_NAME ? `${name} (default)` : name,
      value: name,
      description: `${style.description} · ${sourceLabel(style)}`,
    }
  })
}

export type OutputStylePickerProps = {
  /** The configured settings value, which may be the `default` alias. */
  initialStyle: string | undefined
  onComplete: (style: string) => void
  onCancel: () => void
  isStandaloneCommand?: boolean
}

export function OutputStylePicker({
  initialStyle,
  onComplete,
  onCancel,
  isStandaloneCommand,
}: OutputStylePickerProps): React.ReactNode {
  const [options, setOptions] = useState<OptionWithDescription[]>([])
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    getAllOutputStyles(getCwd())
      .then(styles => setOptions(toOptions(styles)))
      // Custom and plugin styles are unavailable; the built-ins still are.
      .catch(() => setOptions(toOptions(BUILT_IN_OUTPUT_STYLES)))
      .finally(() => setIsLoading(false))
  }, [])

  const handleSelect = useCallback(
    (style: string) => onComplete(style),
    [onComplete],
  )

  const selected = resolveOutputStyleName(initialStyle)
  // Start on the active style, falling back to the first row when the
  // configured style is no longer in the catalogue.
  const focused = options.some(option => option.value === selected)
    ? selected
    : options[0]?.value

  return (
    <Dialog
      title="Output style"
      onCancel={onCancel}
      hideInputGuide={!isStandaloneCommand}
      hideBorder={!isStandaloneCommand}
    >
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>
            An output style shapes how Claude responds, and can replace the
            built-in coding and response guidance.
          </Text>
          <Text dimColor>
            Applies to your next session, or after /clear. Choose{' '}
            {NO_OUTPUT_STYLE_NAME} to turn styling off.
          </Text>
        </Box>
        {isLoading ? (
          <Text dimColor>Loading output styles…</Text>
        ) : (
          <Select
            options={options}
            onChange={handleSelect}
            onCancel={onCancel}
            visibleOptionCount={10}
            defaultValue={selected}
            defaultFocusValue={focused}
          />
        )}
      </Box>
    </Dialog>
  )
}
