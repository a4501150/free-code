/**
 * REPL host adapter for the theme picker: reads the syntaxHighlightingDisabled
 * setting from AppState, wires persistence (settings file + store update) to
 * the panel's callback, and delegates rendering to the host-agnostic
 * panels/ThemePickerDialog component. All mounts (/theme command, onboarding,
 * settings Config submenu) keep using this adapter unchanged.
 */

import * as React from 'react'
import { useAppState, useSetAppState } from '../state/AppState.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import {
  ThemePicker as ThemePickerPanel,
  type ThemePickerProps as PanelThemePickerProps,
} from './panels/ThemePickerDialog/ThemePicker.js'

export type ThemePickerProps = Omit<
  PanelThemePickerProps,
  'syntaxHighlightingDisabled' | 'onSetSyntaxHighlightingDisabled'
>

export function ThemePicker(props: ThemePickerProps): React.ReactNode {
  const syntaxHighlightingDisabled =
    useAppState(s => s.settings.syntaxHighlightingDisabled) ?? false
  const setAppState = useSetAppState()

  return (
    <ThemePickerPanel
      {...props}
      syntaxHighlightingDisabled={syntaxHighlightingDisabled}
      onSetSyntaxHighlightingDisabled={disabled => {
        updateSettingsForSource('userSettings', {
          syntaxHighlightingDisabled: disabled,
        })
        setAppState(prev => ({
          ...prev,
          settings: { ...prev.settings, syntaxHighlightingDisabled: disabled },
        }))
      }}
    />
  )
}
