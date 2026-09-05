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
- Examples, for a file whose Read output shows \`41:9k2|  const x = 1\` and \`44:p0q|  }\`:
  {"op":"replace","start":"41:9k2","lines":"  const x = 2"}
  {"op":"insert_after","start":"41:9k2","lines":"  const y = 3"}
  {"op":"delete","start":"41:9k2","end":"44:p0q"}
- Provide only the content after the \`|\` in \`lines\` — never include the \`LINE:HASH|\` anchor prefix itself.
- HASH fingerprints the line together with its two neighbors, so repeated lines like \`}\` and blank lines get distinct anchors. That also means rewriting a line changes the anchors of its two neighbors: a successful edit returns fresh anchors covering the rewritten lines and their neighbors, so prefer them for any follow-up edit nearby.
- An anchor is matched by content, not by position. If its window moved, the tool finds the line again and says so. If the file no longer holds that window, or holds it more than once, the edit is rejected and every unresolved anchor is listed with the lines that now carry its hash and fresh anchors to use instead.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.`
}
