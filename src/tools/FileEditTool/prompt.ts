import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

function getPreReadInstruction(): string {
  return `\n- Before editing you must use your \`${FILE_READ_TOOL_NAME}\` tool to read that target file. The Read output shows each line as \`LINE:HASH|content\`; copy the \`LINE:HASH\` anchors into your edits. This tool will error if you attempt to edit a file without reading it first.`
}

export function getEditToolDescription(): string {
  return getDefaultEditDescription()
}

function getDefaultEditDescription(): string {
  return `Edits a file by referencing LINE:HASH anchors from the Read tool output.

Usage:${getPreReadInstruction()}
- Each edit has: op ("replace" | "insert_after" | "delete"), start (a "LINE:HASH" anchor), optional end (a "LINE:HASH" anchor for a multi-line replace/delete; defaults to start), and lines (the new text for replace/insert_after; omit for delete).
- replace: replaces lines start..end with \`lines\`. insert_after: inserts \`lines\` after the \`start\` line (use "0" to insert at the top of the file). delete: removes lines start..end.
- Provide only the content after the \`|\` in \`lines\` — never include the \`LINE:HASH|\` anchor prefix itself.
- Anchors are validated against the current file. If the file changed since you read it, the hash won't match and the edit is rejected together with fresh anchors — re-read the file or use the returned anchors and retry.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.`
}
