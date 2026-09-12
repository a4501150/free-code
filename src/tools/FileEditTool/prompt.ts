import { FILE_READ_TOOL_NAME } from '../FileReadTool/prompt.js'
import { shouldPreferBashForSearch } from '../../utils/embeddedTools.js'

export function getEditToolDescription(): string {
  return getDefaultEditDescription()
}

function getDefaultEditDescription(): string {
  // The Grep tool is stripped from the registry when bash-first search is
  // active; naming it then teaches a tool the model does not have. The
  // channel list here must stay in sync with the fileSightings.ts allowlist.
  const hasGrep = !shouldPreferBashForSearch()
  const sightingChannels = hasGrep
    ? `\`${FILE_READ_TOOL_NAME}\` tool, Grep (content mode), or a file-printing Bash command (cat/head/nl/sed -n/grep -n/rg -n)`
    : `\`${FILE_READ_TOOL_NAME}\` tool or a file-printing Bash command (cat/head/nl/sed -n/grep -n/rg -n)`
  const prefixNote = hasGrep
    ? `Read and Grep output prefix each line`
    : `${FILE_READ_TOOL_NAME} output prefixes each line`
  return `Performs exact string replacements in files.

Usage:
- You must use your ${sightingChannels} at least once in the conversation before editing, or keep old_string uniquely identifying: an edit whose old_string matches exactly one place in the current file is applied even for files you have not opened. This tool errors when the placement is ambiguous and you have not read that target file.
- ${prefixNote} with its line number as \`N:content\`. The prefix is not file content: strip it (see the old_string field describe), keeping the exact indentation (tabs/spaces) that follows it.
- \`old_string\` must match the file exactly, including indentation. When the exact match fails, the tool also retries with curly/straight quote swaps, \\uXXXX escape swaps, line-number prefixes removed, and per-line whitespace tolerance on multi-line text.
- \`old_string\` must be unique in the file, or you must disambiguate: extend old_string with more surrounding lines until exactly one copy matches — or use replace_all to change every instance. An ambiguity error lists the line numbers where the copies start, so you can widen the context around the right one in a single retry.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- An empty new_string deletes the matched text; when the match ends a line, the trailing line break is deleted too.
- You may issue several Edit calls for the same file in one response; they apply sequentially, each against the previous edit's result.`
}
