import { basename, relative } from 'path'
import React, { useMemo } from 'react'
import { FileEditToolDiff } from 'src/components/FileEditToolDiff.js'
import { getCwd } from 'src/utils/cwd.js'
import { isENOENT } from 'src/utils/errors.js'
import { readFileSync } from 'src/utils/fileRead.js'
import { applyHashlineEdits } from 'src/utils/hashline.js'
import type { z } from 'zod/v4'
import { Text } from '../../../ink.js'
import { FileEditTool } from '../../../tools/FileEditTool/FileEditTool.js'
import { FilePermissionDialog } from '../FilePermissionDialog/FilePermissionDialog.js'
import {
  createContentDiffConfig,
  type IDEDiffSupport,
} from '../FilePermissionDialog/ideDiffConfig.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'

type FileEditInput = z.infer<typeof FileEditTool.inputSchema>

function readOldContent(filePath: string): string {
  try {
    return readFileSync(filePath)
  } catch (e) {
    if (!isENOENT(e)) throw e
    return ''
  }
}

function computeNewContent(input: FileEditInput): {
  oldContent: string
  newContent: string
} {
  const oldContent = readOldContent(input.file_path)
  const r = applyHashlineEdits(oldContent, input.edits, {
    filePath: input.file_path,
  })
  return { oldContent, newContent: r.ok ? r.updatedContent : oldContent }
}

const ideDiffSupport: IDEDiffSupport<FileEditInput> = {
  getConfig: (input: FileEditInput) => {
    const { oldContent, newContent } = computeNewContent(input)
    return createContentDiffConfig(input.file_path, oldContent, newContent)
  },
  applyChanges: (input: FileEditInput, newContent: string) => ({
    ...input,
    _overrideContent: { newContent },
  }),
}

export function FileEditPermissionRequest(
  props: PermissionRequestProps,
): React.ReactNode {
  const parseInput = (input: unknown): FileEditInput => {
    return FileEditTool.inputSchema.parse(input)
  }

  const parsed = parseInput(props.toolUseConfirm.input)
  const { file_path } = parsed

  // Single read drives the terminal diff preview. Memoized on the raw input so
  // we don't re-read the file on every render.
  const { oldContent, newContent } = useMemo(
    () => computeNewContent(parsed),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [props.toolUseConfirm.input],
  )

  return (
    <FilePermissionDialog
      toolUseConfirm={props.toolUseConfirm}
      toolUseContext={props.toolUseContext}
      onDone={props.onDone}
      onReject={props.onReject}
      workerBadge={props.workerBadge}
      title="Edit file"
      subtitle={relative(getCwd(), file_path)}
      question={
        <Text>
          Do you want to make this edit to{' '}
          <Text bold>{basename(file_path)}</Text>?
        </Text>
      }
      content={
        <FileEditToolDiff
          file_path={file_path}
          oldContent={oldContent}
          newContent={newContent}
        />
      }
      path={file_path}
      completionType="str_replace_single"
      parseInput={parseInput}
      ideDiffSupport={ideDiffSupport}
    />
  )
}
