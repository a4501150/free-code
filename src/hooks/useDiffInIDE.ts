import { randomUUID } from 'crypto'
import { basename } from 'path'
import { useEffect, useMemo, useRef, useState } from 'react'

import { readFileSync } from 'src/utils/fileRead.js'
import { expandPath } from 'src/utils/path.js'
import type { PermissionOption } from '../components/permissions/FilePermissionDialog/permissionOptions.js'
import type {
  MCPServerConnection,
  McpSSEIDEServerConfig,
  McpWebSocketIDEServerConfig,
} from '../services/mcp/types.js'
import type { ToolUseContext } from '../Tool.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { isENOENT } from '../utils/errors.js'
import {
  callIdeRpc,
  getConnectedIdeClient,
  getConnectedIdeName,
  hasAccessToIDEExtensionDiffFeature,
} from '../utils/ide.js'
import { WindowsToWSLConverter } from '../utils/idePathConversion.js'
import { logError } from '../utils/log.js'
import { getPlatform } from '../utils/platform.js'

type Props = {
  onChange(
    option: PermissionOption,
    input: {
      file_path: string
      newContent: string
    },
  ): void
  toolUseContext: ToolUseContext
  filePath: string
  oldContent: string
  newContent: string
  editMode: 'single' | 'multiple'
}

export function useDiffInIDE({
  onChange,
  toolUseContext,
  filePath,
  newContent,
}: Props): {
  closeTabInIDE: () => void
  showingDiffInIDE: boolean
  ideName: string
  hasError: boolean
} {
  const isUnmounted = useRef(false)
  const [hasError, setHasError] = useState(false)

  const sha = useMemo(() => randomUUID().slice(0, 6), [])
  const tabName = useMemo(
    () => `✻ [Claude Code] ${basename(filePath)} (${sha}) ⧉`,
    [filePath, sha],
  )

  const shouldShowDiffInIDE =
    hasAccessToIDEExtensionDiffFeature(toolUseContext.options.mcpClients) &&
    (getInitialSettings().diffTool ?? 'auto') === 'auto' &&
    // Diffs should only be for file edits.
    // File writes may come through here but are not supported for diffs.
    !filePath.endsWith('.ipynb')

  const ideName =
    getConnectedIdeName(toolUseContext.options.mcpClients) ?? 'IDE'

  async function showDiff(): Promise<void> {
    if (!shouldShowDiffInIDE) {
      return
    }

    try {
      const { oldContent: baseContent, newContent: finalContent } =
        await showDiffInIDE(filePath, newContent, toolUseContext, tabName)
      // Skip if component has been unmounted
      if (isUnmounted.current) {
        return
      }

      if (finalContent === baseContent) {
        // No changes -- edit was rejected (eg. reverted)
        // We close the tab here because 'no' no longer auto-closes
        const ideClient = getConnectedIdeClient(
          toolUseContext.options.mcpClients,
        )
        if (ideClient) {
          // Close the tab in the IDE
          await closeTabInIDE(tabName, ideClient)
        }
        onChange(
          { type: 'reject' },
          {
            file_path: filePath,
            newContent,
          },
        )
        return
      }

      // File was modified - edit was accepted (finalContent may include the
      // user's manual amendments made in the IDE diff view).
      onChange(
        { type: 'accept-once' },
        {
          file_path: filePath,
          newContent: finalContent,
        },
      )
    } catch (error) {
      logError(error as Error)
      setHasError(true)
    }
  }

  useEffect(() => {
    void showDiff()

    // Set flag on unmount, and make sure the IDE tab does not outlive the
    // approval prompt (e.g. the user answered in the terminal and the
    // dialog unmounted before the diff resolved). Best-effort: closing an
    // already-closed tab is a swallowed no-op on the IDE side.
    return () => {
      isUnmounted.current = true
      const ideClient = getConnectedIdeClient(toolUseContext.options.mcpClients)
      if (ideClient) {
        void closeTabInIDE(tabName, ideClient)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return {
    closeTabInIDE() {
      const ideClient = getConnectedIdeClient(toolUseContext.options.mcpClients)

      if (!ideClient) {
        return Promise.resolve()
      }

      return closeTabInIDE(tabName, ideClient)
    },
    showingDiffInIDE: shouldShowDiffInIDE && !hasError,
    ideName: ideName,
    hasError,
  }
}

/**
 * Done if:
 *
 * 1. Tab is closed in IDE
 * 2. Tab is saved in IDE (we then close the tab)
 * 3. User selected an option in IDE
 * 4. User selected an option in terminal (or hit esc)
 * 5. The IDE went away (or never answered): the wait times out after
 *    IDLE_TIMEOUT_MS, rejects like a closed tab, and the caller falls back
 *    to the terminal permission UI (hasError flips showingDiffInIDE off)
 *
 * Resolves with the new file content. The tab is also closed when the
 * approval prompt unmounts (see the hook's unmount cleanup).
 */
const IDE_DIFF_IDLE_TIMEOUT_MS = 5 * 60 * 1000
async function showDiffInIDE(
  file_path: string,
  proposedContent: string,
  toolUseContext: ToolUseContext,
  tabName: string,
): Promise<{ oldContent: string; newContent: string }> {
  let isCleanedUp = false

  const oldFilePath = expandPath(file_path)
  let oldContent = ''
  try {
    oldContent = readFileSync(oldFilePath)
  } catch (e: unknown) {
    if (!isENOENT(e)) {
      throw e
    }
  }

  let idleTimeout: ReturnType<typeof setTimeout> | undefined

  async function cleanup() {
    // Careful to avoid race conditions, since this
    // function can be called from multiple places.
    if (isCleanedUp) {
      return
    }
    isCleanedUp = true

    if (idleTimeout !== undefined) {
      clearTimeout(idleTimeout)
    }

    // Don't fail if this fails
    try {
      await closeTabInIDE(tabName, ideClient)
    } catch (e) {
      logError(e as Error)
    }

    process.off('beforeExit', cleanup)
    toolUseContext.abortController.signal.removeEventListener('abort', cleanup)
  }

  // Cleanup if the user hits esc to cancel the tool call - or on exit
  toolUseContext.abortController.signal.addEventListener('abort', cleanup)
  process.on('beforeExit', cleanup)

  // Open the diff in the IDE
  const ideClient = getConnectedIdeClient(toolUseContext.options.mcpClients)
  try {
    const updatedFile = proposedContent

    if (!ideClient || ideClient.type !== 'connected') {
      throw new Error('IDE client not available')
    }
    let ideOldPath = oldFilePath

    // Only convert paths if we're in WSL and IDE is on Windows
    const ideRunningInWindows =
      (ideClient.config as McpSSEIDEServerConfig | McpWebSocketIDEServerConfig)
        .ideRunningInWindows === true
    if (
      getPlatform() === 'wsl' &&
      ideRunningInWindows &&
      process.env.WSL_DISTRO_NAME
    ) {
      const converter = new WindowsToWSLConverter(process.env.WSL_DISTRO_NAME)
      ideOldPath = converter.toIDEPath(oldFilePath)
    }

    // Cap the wait: if the IDE exits (or the extension stops answering),
    // the openDiff call may never resolve. Timing out rejects like a closed
    // tab, so the caller falls back to the terminal permission UI.
    const rpcResult = await Promise.race([
      callIdeRpc(
        'openDiff',
        {
          old_file_path: ideOldPath,
          new_file_path: ideOldPath,
          new_file_contents: updatedFile,
          tab_name: tabName,
        },
        ideClient,
      ),
      new Promise<never>((_, reject) => {
        idleTimeout = setTimeout(
          () =>
            reject(
              new Error(
                `IDE diff timed out after ${IDE_DIFF_IDLE_TIMEOUT_MS / 60000} minutes of inactivity`,
              ),
            ),
          IDE_DIFF_IDLE_TIMEOUT_MS,
        )
        idleTimeout.unref?.()
      }),
    ])

    // Convert the raw RPC result to a ToolCallResponse format
    const data = Array.isArray(rpcResult) ? rpcResult : [rpcResult]

    // If the user saved the file then take the new contents and resolve with that.
    if (isSaveMessage(data)) {
      void cleanup()
      return {
        oldContent: oldContent,
        newContent: data[1].text,
      }
    } else if (isClosedMessage(data)) {
      void cleanup()
      return {
        oldContent: oldContent,
        newContent: updatedFile,
      }
    } else if (isRejectedMessage(data)) {
      void cleanup()
      return {
        oldContent: oldContent,
        newContent: oldContent,
      }
    }

    // Indicates that the tool call completed with none of the expected
    // results. Did the user close the IDE?
    throw new Error('Not accepted')
  } catch (error) {
    logError(error as Error)
    void cleanup()
    throw error
  }
}

async function closeTabInIDE(
  tabName: string,
  ideClient?: MCPServerConnection | undefined,
): Promise<void> {
  try {
    if (!ideClient || ideClient.type !== 'connected') {
      throw new Error('IDE client not available')
    }

    // Use direct RPC to close the tab
    await callIdeRpc('close_tab', { tab_name: tabName }, ideClient)
  } catch (error) {
    logError(error as Error)
    // Don't throw - this is a cleanup operation
  }
}

function isClosedMessage(data: unknown): data is { text: 'TAB_CLOSED' } {
  return (
    Array.isArray(data) &&
    typeof data[0] === 'object' &&
    data[0] !== null &&
    'type' in data[0] &&
    data[0].type === 'text' &&
    'text' in data[0] &&
    data[0].text === 'TAB_CLOSED'
  )
}

function isRejectedMessage(data: unknown): data is { text: 'DIFF_REJECTED' } {
  return (
    Array.isArray(data) &&
    typeof data[0] === 'object' &&
    data[0] !== null &&
    'type' in data[0] &&
    data[0].type === 'text' &&
    'text' in data[0] &&
    data[0].text === 'DIFF_REJECTED'
  )
}

function isSaveMessage(
  data: unknown,
): data is [{ text: 'FILE_SAVED' }, { text: string }] {
  return (
    Array.isArray(data) &&
    data[0]?.type === 'text' &&
    data[0].text === 'FILE_SAVED' &&
    typeof data[1].text === 'string'
  )
}
