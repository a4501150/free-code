import { isPDFSupported } from '../../utils/pdfUtils.js'
import { BASH_TOOL_NAME } from '../BashTool/toolName.js'

// Use a string constant for tool names to avoid circular dependencies
export const FILE_READ_TOOL_NAME = 'Read'

export const FILE_UNCHANGED_STUB =
  'File unchanged since last read. The content from the earlier Read tool_result in this conversation is still current — refer to that instead of re-reading.'

export const MAX_LINES_TO_READ = 2000

export const DESCRIPTION = 'Read a file from the local filesystem.'

export const LINE_FORMAT_INSTRUCTION =
  '- Results are returned using cat -n format, with line numbers starting at 1'

/**
 * Renders the Read tool prompt template.  The caller (FileReadTool) supplies
 * the runtime-computed parts.
 */
export function renderPromptTemplate(
  lineFormat: string,
  maxSizeInstruction: string,
): string {
  return `Reads a file from the local filesystem. You can access any file directly by using this tool.
Assume this tool is able to read all files on the machine. If the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.

Usage:
- The file_path parameter must be an absolute path, not a relative path
${maxSizeInstruction ? `- ${maxSizeInstruction}` : ''}
${lineFormat}
- This tool allows Claude Code to read images (eg PNG, JPG, etc). When reading an image file the contents are presented visually as Claude Code is a multimodal LLM.${
    isPDFSupported()
      ? '\n- This tool can read PDF files (.pdf); use the `pages` parameter for large PDFs.'
      : ''
  }
- This tool can read Jupyter notebooks (.ipynb files) and returns all cells with their outputs, combining code, text, and visualizations.
- This tool can only read files, not directories. To read a directory, use an ls command via the ${BASH_TOOL_NAME} tool.
- You will regularly be asked to read screenshots. If the user provides a path to a screenshot, ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths.
- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.`
}
