import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

export function getEditToolDescription(): string {
  return getDefaultEditDescription()
}

function getDefaultEditDescription(): string {
  // The channel list here must stay in sync with the fileSightings.ts allowlist.
  return `Performs exact string replacements in files.

Usage:
- You must use your \`${FILE_READ_TOOL_NAME}\` tool or a file-printing Bash command (cat/head/nl/sed -n/grep -n/rg -n; chains of these joined by \`;\` or \`&&\` also count, but a pipe stage reading stdin voids the whole command) at least once in the conversation before editing an unread file. An edit whose old_string matches exactly one place in the file is applied even for files you have not opened; an ambiguous match in an unread file errors and lists the candidate line numbers, so you can widen the context in a single retry.
- \`old_string\` must match the file exactly, including indentation, and must be unique in the file — extend it with more surrounding lines to disambiguate, or use replace_all to change every instance.
- One edit per call. For several changes in one file or across files, issue multiple Edit calls in the same turn: same-file calls serialize safely, each matched against the file as the previous call left it.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- An empty new_string deletes the matched text; when the match ends a line, the trailing line break is deleted too.`
}
