import type { DomainToolResultBlockParam } from '../../types/domain.js'
import type { StructuredPatchHunk } from 'diff'
import * as React from 'react'
import { Suspense, use, useState } from 'react'
import { FileEditToolUseRejectedMessage } from 'src/components/FileEditToolUseRejectedMessage.js'
import { MessageResponse } from 'src/components/MessageResponse.js'
import { extractTag } from 'src/utils/messages.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { FileEditToolUpdatedMessage } from '../../components/FileEditToolUpdatedMessage.js'
import { FilePathLink } from '../../components/FilePathLink.js'
import { Text } from '../../ink.js'
import type { Tools } from '../../Tool.js'
import type { Message, ProgressMessage } from '../../types/message.js'
import { getPatchFromContents } from '../../utils/diff.js'
import {
  convertLeadingTabsToSpaces,
  FILE_NOT_FOUND_CWD_NOTE,
  getDisplayPath,
} from '../../utils/file.js'
import { applyHashlineEdits } from '../../utils/hashline.js'
import { logError } from '../../utils/log.js'
import { getPlansDirectory } from '../../utils/plans.js'
import { openForScan, readCapped } from '../../utils/readEditContext.js'
import { firstLineOf } from '../../utils/stringUtils.js'
import type { ThemeName } from '../../utils/theme.js'
import type { EditOp, FileEditOutput } from './types.js'

export function userFacingName(
  input: Partial<{ file_path: string; edits: unknown[] }> | undefined,
): string {
  // Hashline edits always modify an existing file (line-ref based).
  if (input?.file_path?.startsWith(getPlansDirectory())) {
    return 'Updated plan'
  }
  return 'Update'
}

export function getToolUseSummary(
  input: Partial<{ file_path: string }> | undefined,
): string | null {
  if (!input?.file_path) {
    return null
  }
  return getDisplayPath(input.file_path)
}

export function renderToolUseMessage(
  { file_path }: { file_path?: string },
  { verbose }: { verbose: boolean },
): React.ReactNode {
  if (!file_path) {
    return null
  }
  // For plan files, path is already in userFacingName
  if (file_path.startsWith(getPlansDirectory())) {
    return ''
  }
  return (
    <FilePathLink filePath={file_path}>
      {verbose ? file_path : getDisplayPath(file_path)}
    </FilePathLink>
  )
}

export function renderToolResultMessage(
  { filePath, structuredPatch, originalFile }: FileEditOutput,
  _progressMessagesForMessage: ProgressMessage[],
  { style, verbose }: { style?: 'condensed'; verbose: boolean },
): React.ReactNode {
  // For plan files, show /plan hint above the diff
  const isPlanFile = filePath.startsWith(getPlansDirectory())

  return (
    <FileEditToolUpdatedMessage
      filePath={filePath}
      structuredPatch={structuredPatch}
      firstLine={originalFile.split('\n')[0] ?? null}
      fileContent={originalFile}
      style={style}
      verbose={verbose}
      previewHint={isPlanFile ? '/plan to preview' : undefined}
    />
  )
}

export function renderToolUseRejectedMessage(
  input: {
    file_path: string
    edits?: EditOp[]
  },
  options: {
    columns: number
    messages: Message[]
    progressMessagesForMessage: ProgressMessage[]
    style?: 'condensed'
    theme: ThemeName
    tools: Tools
    verbose: boolean
  },
): React.ReactElement {
  const { style, verbose } = options
  const filePath = input.file_path
  const edits = input.edits ?? []

  if (edits.length === 0) {
    return (
      <FileEditToolUseRejectedMessage
        file_path={filePath}
        operation="update"
        firstLine={null}
        verbose={verbose}
      />
    )
  }

  return (
    <EditRejectionDiff
      filePath={filePath}
      edits={edits}
      style={style}
      verbose={verbose}
    />
  )
}

export function renderToolUseErrorMessage(
  result: DomainToolResultBlockParam['content'],
  options: {
    progressMessagesForMessage: ProgressMessage[]
    tools: Tools
    verbose: boolean
  },
): React.ReactElement {
  const { verbose } = options
  if (
    !verbose &&
    typeof result === 'string' &&
    extractTag(result, 'tool_use_error')
  ) {
    const errorMessage = extractTag(result, 'tool_use_error')
    // Show a less scary message for intended behavior
    if (errorMessage?.includes('File has not been read yet')) {
      return (
        <MessageResponse>
          <Text dimColor>File must be read first</Text>
        </MessageResponse>
      )
    }
    if (errorMessage?.includes(FILE_NOT_FOUND_CWD_NOTE)) {
      return (
        <MessageResponse>
          <Text color="error">File not found</Text>
        </MessageResponse>
      )
    }
    return (
      <MessageResponse>
        <Text color="error">Error editing file</Text>
      </MessageResponse>
    )
  }
  return <FallbackToolUseErrorMessage result={result} verbose={verbose} />
}

type RejectionDiffData = {
  patch: StructuredPatchHunk[]
  firstLine: string | null
  fileContent: string | undefined
}

function EditRejectionDiff({
  filePath,
  edits,
  style,
  verbose,
}: {
  filePath: string
  edits: EditOp[]
  style?: 'condensed'
  verbose: boolean
}): React.ReactNode {
  const [dataPromise] = useState(() => loadRejectionDiff(filePath, edits))
  return (
    <Suspense
      fallback={
        <FileEditToolUseRejectedMessage
          file_path={filePath}
          operation="update"
          firstLine={null}
          verbose={verbose}
        />
      }
    >
      <EditRejectionBody
        promise={dataPromise}
        filePath={filePath}
        style={style}
        verbose={verbose}
      />
    </Suspense>
  )
}

function EditRejectionBody({
  promise,
  filePath,
  style,
  verbose,
}: {
  promise: Promise<RejectionDiffData>
  filePath: string
  style?: 'condensed'
  verbose: boolean
}): React.ReactNode {
  const { patch, firstLine, fileContent } = use(promise)
  return (
    <FileEditToolUseRejectedMessage
      file_path={filePath}
      operation="update"
      patch={patch}
      firstLine={firstLine}
      fileContent={fileContent}
      style={style}
      verbose={verbose}
    />
  )
}

async function loadRejectionDiff(
  filePath: string,
  edits: EditOp[],
): Promise<RejectionDiffData> {
  const empty: RejectionDiffData = {
    patch: [],
    firstLine: null,
    fileContent: undefined,
  }
  try {
    // Hashline anchors are absolute line numbers, so applying them needs the
    // whole file. readCapped bounds the read; the rendered hunks are bounded by
    // getPatchFromContents' context window.
    const handle = await openForScan(filePath)
    if (handle === null) return empty
    let oldContent: string | null
    try {
      oldContent = await readCapped(handle)
    } finally {
      await handle.close()
    }
    if (oldContent === null) return empty
    const r = applyHashlineEdits(oldContent, edits, filePath)
    if (!r.ok) return empty
    const patch = getPatchFromContents({
      filePath,
      oldContent: convertLeadingTabsToSpaces(oldContent),
      newContent: convertLeadingTabsToSpaces(r.updatedContent),
    })
    return {
      patch,
      firstLine: firstLineOf(oldContent),
      fileContent: oldContent,
    }
  } catch (e) {
    // User may have manually applied the change while the diff was shown.
    logError(e as Error)
    return empty
  }
}
