/**
 * A render-error boundary for the attached-session viewer's dialog and
 * tray mounts.
 *
 * Ink's root error boundary EXITS the app on any render error
 * (componentDidCatch → handleExit), so a dialog that throws while
 * rendering — e.g. a host that passes a narrower ToolUseContext than a
 * classic dialog reads — would kill the whole session process, and while
 * it was wedged the repeated error/re-render cycle burned CPU for hours.
 * This boundary is the nearest catcher: it logs, then renders one dim
 * error row in place of the crashed dialog instead of exiting. The rest
 * of the viewer (transcript, composer, trays) keeps running, and the
 * user can still Esc or answer other queued requests.
 */
import React from 'react'
import { Box, Text } from '../ink.js'
import { logError } from '../utils/log.js'

type Props = {
  /** Human label for the crash row, e.g. `dialog` or `permission tray`. */
  label: string
  children: React.ReactNode
}

type State = { error: Error | null }

export class ViewerErrorBoundary extends React.Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error): void {
    logError(error)
  }

  override render(): React.ReactNode {
    const { error } = this.state
    if (error) {
      return (
        <Box paddingX={2}>
          <Text color="error" dimColor>
            {this.props.label} failed to render ({error.message}) — Esc to
            dismiss
          </Text>
        </Box>
      )
    }
    return this.props.children
  }
}
