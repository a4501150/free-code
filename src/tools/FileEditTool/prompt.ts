import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

export function getEditToolDescription(): string {
  return getDefaultEditDescription()
}

function getDefaultEditDescription(): string {
  // The channel list here must stay in sync with the fileSightings.ts allowlist.
  return `Performs exact string replacements in files.

Usage:
- You must use your \`${FILE_READ_TOOL_NAME}\` tool or a file-printing Bash command (cat/head/nl/sed -n/grep -n/rg -n; chains of these joined by \`;\` or \`&&\` also count, but a pipe stage reading stdin voids the whole command) at least once in the conversation before editing an unread file. An edit whose old_string matches exactly one place in the file — or an \`edits\` batch whose every entry does — is applied even for files you have not opened; an ambiguous match in an unread file errors and lists the candidate line numbers, so you can widen the context in a single retry.
- \`old_string\` must match the file exactly, including indentation, and must be unique in the file — extend it with more surrounding lines to disambiguate, or use replace_all to change every instance.
- Large rewrite? Pass \`end_string\` too: \`old_string\` becomes the unique start anchor and \`end_string\` the unique end anchor, and everything from the start of the first through the end of the second (inclusive) is replaced by \`new_string\`. You then quote two short unique lines instead of the whole block. Each anchor must match exactly once; the anchors must not overlap.
- Several changes to the same file? Pass \`edits\`: an array of {old_string, new_string} entries (each optionally end_string/replace_all). Every entry is validated against the current file content before anything is written — if any entry fails to match uniquely or two entries overlap, NOTHING is applied and the error names the failing entry. Prefer one edits[] call over repeated single edits.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- An empty new_string deletes the matched text; when the match ends a line, the trailing line break is deleted too.`
}
