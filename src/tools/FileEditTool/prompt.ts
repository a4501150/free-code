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
- HASH fingerprints the trimmed line together with its line number, so repeated lines like \`}\` and blank lines get distinct anchors, and rewriting one line never changes another line's anchor. A successful edit returns fresh anchors for the lines it wrote; use them for follow-up edits there, and note the reported line shift for anchors you still hold below the edit.
- An anchor asserts "line LINE of the file I was shown has this content". The tool resolves it against the current file, remapping past earlier edits from the SAME message (their line shifts are known). It rejects an anchor whose line an earlier same-message edit rewrote, or whose content changed since you read it — then it lists each failed anchor and quotes fresh anchors near the affected lines.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.`
}
