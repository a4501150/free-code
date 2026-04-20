import * as React from 'react'
import { DiffDialog } from '../../components/diff/DiffDialog.js'
import type { LocalJSXCommandCall } from '../../types/command.js'

export const call: LocalJSXCommandCall = async (onDone, context) => {
  return <DiffDialog messages={context.messages} onDone={onDone} />
}
