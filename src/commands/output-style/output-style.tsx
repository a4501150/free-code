import chalk from 'chalk'
import * as React from 'react'
import type { CommandResultDisplay } from '../../commands.js'
import { OutputStylePicker } from '../../components/OutputStylePicker.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import {
  getActiveOutputStyleNameSync,
  getAllOutputStyles,
  getOutputStyleOverrideNotice,
  resolveOutputStyleName,
} from '../../outputStyles/outputStyles.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { getCwd } from '../../utils/cwd.js'
import {
  getInitialSettings,
  updateSettingsForSource,
} from '../../utils/settings/settings.js'

type OnDone = (
  result?: string,
  options?: { display?: CommandResultDisplay },
) => void

/**
 * Persist to user settings without touching the running session: the active
 * style is snapshotted per process so a live conversation's cached system
 * prompt never moves under it.
 */
async function selectStyle(name: string, onDone: OnDone): Promise<void> {
  const { error } = updateSettingsForSource('userSettings', {
    outputStyle: name,
  })
  if (error) {
    onDone(`Failed to save output style: ${error.message}`, {
      display: 'system',
    })
    return
  }

  const notice = await getOutputStyleOverrideNotice(name)
  const lines = [
    `Set output style to ${chalk.bold(name)} — applies to your next session, or after /clear.`,
  ]
  if (notice) lines.push(notice)
  onDone(lines.join('\n'))
}

function OutputStylePickerWrapper({
  onDone,
}: {
  onDone: OnDone
}): React.ReactNode {
  function handleCancel(): void {
    onDone(
      `Kept output style as ${chalk.bold(getActiveOutputStyleNameSync())}`,
      {
        display: 'system',
      },
    )
  }

  return (
    <OutputStylePicker
      initialStyle={getInitialSettings().outputStyle}
      onComplete={style => void selectStyle(style, onDone)}
      onCancel={handleCancel}
      isStandaloneCommand
    />
  )
}

function SetOutputStyleAndClose({
  args,
  onDone,
}: {
  args: string
  onDone: OnDone
}): React.ReactNode {
  React.useEffect(() => {
    async function apply(): Promise<void> {
      const name = resolveOutputStyleName(args)
      const styles = await getAllOutputStyles(getCwd())
      if (!(name in styles)) {
        onDone(
          `Unknown output style '${args}'. Run /output-style to choose from the available styles.`,
          { display: 'system' },
        )
        return
      }
      await selectStyle(name, onDone)
    }

    void apply()
  }, [args, onDone])

  return null
}

export const call: LocalJSXCommandCall = async (onDone, _context, args) => {
  args = args?.trim() || ''

  if (COMMON_INFO_ARGS.includes(args)) {
    onDone(`Current output style: ${getActiveOutputStyleNameSync()}`)
    return
  }
  if (COMMON_HELP_ARGS.includes(args)) {
    onDone(
      'Run /output-style to choose an output style, or /output-style [name] to set one. Styles come from the built-ins, output-styles config directories, and plugins. Changes apply to your next session.',
      { display: 'system' },
    )
    return
  }

  if (args) {
    return <SetOutputStyleAndClose args={args} onDone={onDone} />
  }

  return <OutputStylePickerWrapper onDone={onDone} />
}
