/**
 * DialogSlot — host-agnostic mount for slash-command dialogs. Renders the
 * bottom-anchored modal pane (▔ divider, paddingX=2) that paints over the
 * scrollable area AND bottom slot, and provides ModalContext so Pane/Dialog
 * inside skip their own frame. Any host can mount a dialog through this
 * slot; the dialog content itself decides what renders.
 */

import * as React from 'react'
import { ModalContext } from '../../../context/modalContext.js'
import { useTerminalSize } from '../../../hooks/useTerminalSize.js'
import type { ScrollBoxHandle } from '../../../ink/components/ScrollBox.js'
import { Box, Text } from '../../../ink.js'

/** Rows of transcript context kept visible above the modal pane's ▔ divider. */
const MODAL_TRANSCRIPT_PEEK = 2

type Props = {
  children: React.ReactNode
  /** Passed via ModalContext so Tabs (or any scroll-owning descendant) can
   *  attach it to their own ScrollBox for tall content. */
  scrollRef?: React.RefObject<ScrollBoxHandle | null>
}

export function DialogSlot({ children, scrollRef }: Props): React.ReactNode {
  const { rows: terminalRows, columns } = useTerminalSize()
  return (
    <ModalContext
      value={{
        rows: terminalRows - MODAL_TRANSCRIPT_PEEK - 1,
        columns: columns - 4,
        scrollRef: scrollRef ?? null,
      }}
    >
      {/* Bottom-anchored, grows upward to fit content. maxHeight keeps a
            few rows of transcript peek above the ▔ divider. Short modals
            (/model) sit small at the bottom with lots of transcript above;
            tall modals grow as needed, clipped by overflow.
            Previously fixed-height (top+bottom anchored) — any fixed cap
            either clipped tall content or left short content floating in
            a mostly-empty pane.

            flexShrink=0 on the inner Box is load-bearing: with Shrink=1,
            yoga squeezes deep children to h=0 when content > maxHeight,
            and sibling Texts land on the same row → ghost overlap
            ("5 serversP servers"). Clipping at the outer Box's maxHeight
            keeps children at natural size.

            Divider wrapped in flexShrink=0: when the inner box overflows
            (tall /config option list), yoga shrinks the divider Text to
            h=0 to absorb the deficit — it's the only shrinkable sibling.
            The wrapper keeps it at 1 row; overflow past maxHeight is
            clipped at the bottom by overflow=hidden instead. */}
      <Box
        position="absolute"
        bottom={0}
        left={0}
        right={0}
        maxHeight={terminalRows - MODAL_TRANSCRIPT_PEEK}
        flexDirection="column"
        overflow="hidden"
        opaque
      >
        <Box flexShrink={0}>
          <Text color="permission">{'▔'.repeat(columns)}</Text>
        </Box>
        <Box
          flexDirection="column"
          paddingX={2}
          flexShrink={0}
          overflow="hidden"
        >
          {children}
        </Box>
      </Box>
    </ModalContext>
  )
}
