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
- Each edit has: op ("replace" | "insert_after" | "delete"), start (a "LINE:HASH" anchor), optional end (defaults to start; used for a multi-line replace/delete), and lines (the new text; omit for delete). replace overwrites lines start..end; insert_after inserts after the start line ("0" inserts at the top); delete removes start..end. Write only the content after the \`|\` in \`lines\`, never the anchor prefix.
- Example, for a file whose Read output shows \`41:9k2|  const x = 1\` and \`44:p0q|  }\`:
  {"op":"replace","start":"41:9k2","lines":"  const x = 2"}
  {"op":"delete","start":"41:9k2","end":"44:p0q"}
- An anchor asserts "line LINE of the file I was shown has this content". HASH covers the trimmed line and its number, so repeated lines like \`}\` and blank lines get distinct anchors and rewriting one line never shifts another anchor. All edits resolve against the one Read output you were shown; a failed call reports each rejected anchor and quotes fresh anchors near the affected lines.
- Batch every change to one file into a single call; a success retires every anchor you hold for that file — Read it again before editing it again, and issue at most one Edit per file per response. Copy anchors verbatim; a hash taken from grep output, another file, or memory never matches — Read the file again when unsure.`
}
