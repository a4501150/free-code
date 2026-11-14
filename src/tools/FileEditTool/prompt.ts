import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'

export function getEditToolDescription(): string {
  return getDefaultEditDescription()
}

function getDefaultEditDescription(): string {
  // The channel list here must stay in sync with the fileSightings.ts allowlist.
  return `Performs exact string replacements in files.

Usage:
- Read the target with the \`${FILE_READ_TOOL_NAME}\` tool or a file-printing Bash command before editing: \`old_string\` must copy the file's exact current text, including indentation, and must be unique in the file — extend it with more surrounding lines to disambiguate, or use replace_all to change every instance.
- One edit per call. For several changes in one file or across files, issue multiple Edit calls in the same turn: same-file calls serialize safely, each matched against the file as the previous call left it.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- An empty new_string deletes the matched text; when the match ends a line, the trailing line break is deleted too.`
}
