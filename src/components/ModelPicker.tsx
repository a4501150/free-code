import * as React from 'react'
import { isFastModeEnabled } from 'src/utils/fastMode.js'
import { useAppState } from '../state/AppState.js'
import {
  ModelPicker as ModelPickerPanel,
  type Props as PanelProps,
} from './panels/ModelPickerDialog/ModelPicker.js'

export type Props = Omit<PanelProps, 'isFastMode'>

/**
 * REPL host adapter for the model picker: reads fast mode state from the app
 * store and renders the host-agnostic panel. All store-coupled wiring for the
 * /model flow lives in src/commands/model/model.tsx (ModelPickerWrapper).
 */
export function ModelPicker(props: Props): React.ReactNode {
  const isFastMode = useAppState(s =>
    isFastModeEnabled() ? (s.fastMode ?? false) : false,
  )

  return <ModelPickerPanel {...props} isFastMode={isFastMode} />
}
