import * as React from 'react'
import { Passes } from '../../components/Passes/Passes.js'

import type { LocalJSXCommandOnDone } from '../../types/command.js'

export async function call(
  onDone: LocalJSXCommandOnDone,
): Promise<React.ReactNode> {
  return <Passes onDone={onDone} />
}
