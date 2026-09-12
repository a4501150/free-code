import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { shouldPreferBashForSearch } from '../../utils/embeddedTools.js'

export const FILE_WRITE_TOOL_NAME = 'Write'
export const DESCRIPTION = 'Write a file to the local filesystem.'

function getPreReadInstruction(): string {
  // Name the Grep tool only when it is actually registered; see
  // embeddedTools.shouldPreferBashForSearch.
  const channels = shouldPreferBashForSearch()
    ? `a complete view from a Bash command`
    : `a complete view from Grep or Bash`
  return `\n- If this is an existing file, you MUST first have seen the file's whole current contents — with the ${FILE_READ_TOOL_NAME} tool, or ${channels} (a partial view does not count). This tool will fail if you did not see the file first.`
}

export function getWriteToolDescription(): string {
  return `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.${getPreReadInstruction()}
- Prefer the Edit tool for modifying existing files \u2014 it only sends the diff. Use this tool to create new files or for complete rewrites.`
}
