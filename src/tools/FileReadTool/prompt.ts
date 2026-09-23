import { isPDFSupported } from '../../utils/pdfUtils.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'

// Use a string constant for tool names to avoid circular dependencies
export const FILE_READ_TOOL_NAME = 'Read'

export const FILE_UNCHANGED_STUB =
  'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.'

export const MAX_LINES_TO_READ = 2000

export const DESCRIPTION = 'Read a file from the local filesystem.'

export const LINE_FORMAT_INSTRUCTION =
  "- Each line is prefixed with its 1-based line number and a colon, then the verbatim line content (for example `12:  return x`). When copying text out of this output for the Edit tool's `old_string` or `new_string`, strip the `N:` prefix — it is not part of the file content."

/**
 * Renders the Read tool prompt template.  The caller (FileReadTool) supplies
 * the runtime-computed parts.
 */
export function renderPromptTemplate(
  lineFormat: string,
  maxSizeInstruction: string,
): string {
  return `Reads a file from the local filesystem.

Usage:
- The file_path parameter must be an absolute path, not a relative path
${maxSizeInstruction ? `- ${maxSizeInstruction}` : ''}
- For text and source files, provide only \`file_path\` to read the full file. To read a portion, provide \`offset\`, \`limit\`, or both.
${lineFormat}
- This tool can read images (for example PNG, JPG) as visual content, Jupyter notebooks (.ipynb, returning all cells with their outputs), and PDF files (.pdf)${
    isPDFSupported()
      ? ' — use the `pages` parameter for large PDFs, and do not pass `pages` when reading non-PDF files'
      : ''
  }. It reads files, not directories: to list a directory, use an ls command via the ${BASH_TOOL_NAME} tool.`
}
