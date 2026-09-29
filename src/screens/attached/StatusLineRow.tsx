/**
 * The hosted viewer's statusline row: the mirror of the classic footer's
 * <StatusLine> render half. The classic component both RUNS the user's
 * (or the embedded default) statusline command and renders its text; in
 * the hosted process the session drives the command itself
 * (`src/sessiond/hostedStatusLine.ts`) and publishes the result to the
 * shared AppState store's `statusLineText` — the same field the classic
 * component writes. This row reads it. Callers mount it only when this
 * process owns the session: a remote attach shares neither the driver nor
 * necessarily the settings, and showing that user's statusline over
 * someone else's session would lie. The stable-height trick is mirrored
 * too: the row reserves its line while the command has not produced text,
 * so the footer never grows a row and steals one from the scroll viewport.
 */
import * as React from 'react'
import { Ansi, Box, Text } from '../../ink.js'
import { useAppState } from '../../state/AppState.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import { statusLineShouldDisplay } from '../../statusline/payload.js'

/** The row's node (null when the gate says hide) and whether the classic
 *  footer's `? for shortcuts` suppression applies alongside it. */
export function useStatusLine(): {
  node: React.ReactNode
  suppressHint: boolean
} {
  const statusLineText = useAppState(s => s.statusLineText)
  const settings = getInitialSettings()
  if (!statusLineShouldDisplay(settings))
    return { node: null, suppressHint: false }
  const paddingX =
    settings?.statusLine?.type === 'command'
      ? (settings.statusLine.padding ?? 0)
      : 0
  return {
    node: (
      <Box paddingX={paddingX} gap={2}>
        {statusLineText ? (
          <Text wrap="truncate">
            <Ansi>{statusLineText}</Ansi>
          </Text>
        ) : (
          <Text> </Text>
        )}
      </Box>
    ),
    suppressHint: true,
  }
}
