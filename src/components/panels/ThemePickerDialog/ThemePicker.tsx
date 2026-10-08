import * as React from 'react'
import type { ThemeSetting } from '../../../utils/theme.js'
import { Select } from '../../CustomSelect/index.js'
import { Byline } from '../../design-system/Byline.js'
import { KeyboardShortcutHint } from '../../design-system/KeyboardShortcutHint.js'
import { StructuredDiff } from '../../StructuredDiff.js'
import {
  getColorModuleUnavailableReason,
  getSyntaxTheme,
} from '../../StructuredDiff/colorDiff.js'
import { useExitOnCtrlCDWithKeybindings } from '../../../hooks/useExitOnCtrlCDWithKeybindings.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import {
  Box,
  Text,
  usePreviewTheme,
  useTheme,
  useThemeSetting,
} from '../../../ink.js'
import { useRegisterKeybindingContext } from '../../../keybindings/KeybindingContext.js'
import { useKeybinding } from '../../../keybindings/useKeybinding.js'
import { useShortcutDisplay } from '../../../keybindings/useShortcutDisplay.js'
import { gracefulShutdown } from '../../../utils/gracefulShutdown.js'

/**
 * Host-agnostic theme picker panel: renders from neutral props — the current
 * syntax-highlighting state in, a typed write callback out — with no AppState
 * imports. The host adapter at src/components/ThemePicker.tsx reads the store,
 * persists settings and wires the callback.
 */
export type ThemePickerProps = {
  onThemeSelect: (setting: ThemeSetting) => void
  showIntroText?: boolean
  helpText?: string
  showHelpTextBelow?: boolean
  hideEscToCancel?: boolean
  /** Skip exit handling when running in a context that already has it (e.g., onboarding) */
  skipExitHandling?: boolean
  /** Called when the user cancels (presses Escape). If skipExitHandling is true and this is provided, it will be called instead of just saving the preview. */
  onCancel?: () => void
  /** Current value of the syntaxHighlightingDisabled setting. */
  syntaxHighlightingDisabled: boolean
  /** Request a new value for the syntaxHighlightingDisabled setting. */
  onSetSyntaxHighlightingDisabled: (disabled: boolean) => void
}

export function ThemePicker({
  onThemeSelect,
  showIntroText = false,
  helpText = '',
  showHelpTextBelow = false,
  hideEscToCancel = false,
  skipExitHandling = false,
  onCancel: onCancelProp,
  syntaxHighlightingDisabled,
  onSetSyntaxHighlightingDisabled,
}: ThemePickerProps): React.ReactNode {
  const [theme] = useTheme()
  const themeSetting = useThemeSetting()
  const { columns } = useTerminalSize()
  const colorModuleUnavailableReason = getColorModuleUnavailableReason()
  const syntaxTheme =
    colorModuleUnavailableReason === null ? getSyntaxTheme(theme) : null
  const { setPreviewTheme, savePreview, cancelPreview } = usePreviewTheme()

  // Register ThemePicker context so its keybindings take precedence over Global
  useRegisterKeybindingContext('ThemePicker')

  const syntaxToggleShortcut = useShortcutDisplay(
    'theme:toggleSyntaxHighlighting',
    'ThemePicker',
  )

  useKeybinding(
    'theme:toggleSyntaxHighlighting',
    () => {
      if (colorModuleUnavailableReason === null) {
        onSetSyntaxHighlightingDisabled(!syntaxHighlightingDisabled)
      }
    },
    { context: 'ThemePicker' },
  )
  // Always call the hook to follow React rules, but conditionally assign the exit handler
  const exitState = useExitOnCtrlCDWithKeybindings(
    skipExitHandling ? () => {} : undefined,
  )

  const themeOptions: { label: string; value: ThemeSetting }[] = [
    { label: 'Dark mode', value: 'dark' },
    { label: 'Light mode', value: 'light' },
    {
      label: 'Dark mode (colorblind-friendly)',
      value: 'dark-daltonized',
    },
    {
      label: 'Light mode (colorblind-friendly)',
      value: 'light-daltonized',
    },
    {
      label: 'Dark mode (ANSI colors only)',
      value: 'dark-ansi',
    },
    {
      label: 'Light mode (ANSI colors only)',
      value: 'light-ansi',
    },
  ]

  const content = (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="column" gap={1}>
        {showIntroText ? (
          <Text>Let&apos;s get started.</Text>
        ) : (
          <Text bold color="permission">
            Theme
          </Text>
        )}
        <Box flexDirection="column">
          <Text bold>
            Choose the text style that looks best with your terminal
          </Text>
          {helpText && !showHelpTextBelow && <Text dimColor>{helpText}</Text>}
        </Box>
        <Select
          options={themeOptions}
          onFocus={setting => {
            setPreviewTheme(setting as ThemeSetting)
          }}
          onChange={(setting: string) => {
            savePreview()
            onThemeSelect(setting as ThemeSetting)
          }}
          onCancel={
            skipExitHandling
              ? () => {
                  cancelPreview()
                  onCancelProp?.()
                }
              : async () => {
                  cancelPreview()
                  await gracefulShutdown(0)
                }
          }
          visibleOptionCount={themeOptions.length}
          defaultValue={themeSetting}
          defaultFocusValue={themeSetting}
        />
      </Box>
      <Box flexDirection="column" width="100%">
        <Box
          flexDirection="column"
          borderTop
          borderBottom
          borderLeft={false}
          borderRight={false}
          borderStyle="dashed"
          borderColor="subtle"
        >
          <StructuredDiff
            patch={{
              oldStart: 1,
              newStart: 1,
              oldLines: 3,
              newLines: 3,
              lines: [
                ' function greet() {',
                '-  console.log("Hello, World!");',
                '+  console.log("Hello, Claude!");',
                ' }',
              ],
            }}
            dim={false}
            filePath="demo.js"
            firstLine={null}
            width={columns}
          />
        </Box>
        <Text dimColor>
          {' '}
          {colorModuleUnavailableReason === 'settings'
            ? 'Syntax highlighting disabled (syntaxHighlightingDisabled: true in settings)'
            : syntaxHighlightingDisabled
              ? `Syntax highlighting disabled (${syntaxToggleShortcut} to enable)`
              : syntaxTheme
                ? `Syntax theme: ${syntaxTheme.theme}${syntaxTheme.source ? ` (from ${syntaxTheme.source})` : ''} (${syntaxToggleShortcut} to disable)`
                : `Syntax highlighting enabled (${syntaxToggleShortcut} to disable)`}
        </Text>
      </Box>
    </Box>
  )

  // Only wrap in a box when not in onboarding
  if (!showIntroText) {
    return (
      <>
        <Box flexDirection="column">{content}</Box>
        <Box marginTop={1}>
          {showHelpTextBelow && helpText && (
            <Box marginLeft={3}>
              <Text dimColor>{helpText}</Text>
            </Box>
          )}
          {!hideEscToCancel && (
            <Box>
              <Text dimColor italic>
                {exitState.pending ? (
                  <>Press {exitState.keyName} again to exit</>
                ) : (
                  <Byline>
                    <KeyboardShortcutHint shortcut="Enter" action="select" />
                    <KeyboardShortcutHint shortcut="Esc" action="cancel" />
                  </Byline>
                )}
              </Text>
            </Box>
          )}
        </Box>
      </>
    )
  }

  return content
}
