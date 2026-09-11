import type { DomainToolResultBlockParam } from '../../types/domain.js'
import type { StructuredPatchHunk } from 'diff'
import * as React from 'react'
import { Suspense, use, useState } from 'react'
import { FileEditToolUseRejectedMessage } from 'src/components/FileEditToolUseRejectedMessage.js'
import { FallbackToolUseErrorMessage } from '../../components/FallbackToolUseErrorMessage.js'
import { FileEditToolUpdatedMessage } from '../../components/FileEditToolUpdatedMessage.js'
import { FilePathLink } from '../../components/FilePathLink.js'
import { Text } from '../../ink.js'
import type { Tools } from '../../Tool.js'
import type { Message, ProgressMessage } from '../../types/message.js'
import { getPatchFromContents } from '../../utils/diff.js'
import { convertLeadingTabsToSpaces, getDisplayPath } from '../../utils/file.js'
import { planEdit } from '../../utils/editMatch.js'
import { logError } from '../../utils/log.js'
import { getPlansDirectory } from '../../utils/plans.js'
import { openForScan, readCapped } from '../../utils/readEditContext.js'
import { firstLineOf } from '../../utils/stringUtils.js'
import type { ThemeName } from '../../utils/theme.js'
import type { FileEditOutput } from './types.js'

export function userFacingName(
  input: Partial<{ file_path: string }> | undefined,
): string {
  // Edit modifies an existing file except in creation mode (empty old_string).
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
    old_string?: string
    new_string?: string
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
  const oldString = input.old_string
  const newString = input.new_string ?? ''

  if (!oldString) {
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
      oldString={oldString}
      newString={newString}
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
  // The model-facing <tool_use_error> message is the source of truth for what
  // went wrong (every variant names its remedy), so the UI renders it as-is
  // instead of substituting static per-case strings.
  return (
    <FallbackToolUseErrorMessage result={result} verbose={options.verbose} />
  )
}

type RejectionDiffData = {
  patch: StructuredPatchHunk[]
  firstLine: string | null
  fileContent: string | undefined
}

function EditRejectionDiff({
  filePath,
  oldString,
  newString,
  style,
  verbose,
}: {
  filePath: string
  oldString: string
  newString: string
  style?: 'condensed'
  verbose: boolean
}): React.ReactNode {
  const [dataPromise] = useState(() =>
    loadRejectionDiff(filePath, oldString, newString),
  )
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
  oldString: string,
  newString: string,
): Promise<RejectionDiffData> {
  const empty: RejectionDiffData = {
    patch: [],
    firstLine: null,
    fileContent: undefined,
  }
  try {
    // The replacement is content-local, but the rendered patch covers the
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
    const r = planEdit(oldContent, {
      oldString,
      newString,
      replaceAll: false,
    })
    if (!r.ok) return empty
    const patch = getPatchFromContents({
      filePath,
      oldContent: convertLeadingTabsToSpaces(oldContent),
      newContent: convertLeadingTabsToSpaces(r.plan.updatedContent),
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
