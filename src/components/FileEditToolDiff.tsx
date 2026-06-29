import * as React from 'react'
import { useMemo } from 'react'
import { useTerminalSize } from '../hooks/useTerminalSize.js'
import { Box, Text } from '../ink.js'
import { getPatchFromContents } from '../utils/diff.js'
import { convertLeadingTabsToSpaces } from '../utils/file.js'
import { firstLineOf } from '../utils/stringUtils.js'
import { StructuredDiffList } from './StructuredDiffList.js'

type Props = {
  file_path: string
  oldContent: string
  newContent: string
}

/**
 * Generic before/after diff. Computes hunks from old/new content with
 * getPatchFromContents — the single content-based diff used by Edit/Write/sed
 * previews. Leading tabs are rendered as spaces to match the TUI diff styling.
 */
export function FileEditToolDiff({
  file_path,
  oldContent,
  newContent,
}: Props): React.ReactNode {
  const { columns } = useTerminalSize()
  const patch = useMemo(
    () =>
      getPatchFromContents({
        filePath: file_path,
        oldContent: convertLeadingTabsToSpaces(oldContent),
        newContent: convertLeadingTabsToSpaces(newContent),
      }),
    [file_path, oldContent, newContent],
  )

  return (
    <Box flexDirection="column">
      <Box
        borderColor="subtle"
        borderStyle="dashed"
        flexDirection="column"
        borderLeft={false}
        borderRight={false}
      >
        {patch.length === 0 ? (
          <Text dimColor>…</Text>
        ) : (
          <StructuredDiffList
            hunks={patch}
            dim={false}
            width={columns}
            filePath={file_path}
            firstLine={firstLineOf(oldContent)}
            fileContent={oldContent}
          />
        )}
      </Box>
    </Box>
  )
}
