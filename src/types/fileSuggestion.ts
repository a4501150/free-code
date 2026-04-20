/**
 * Input passed to a user-configured file-suggestion hook command.
 * Shape mirrors how the command is invoked in src/hooks/fileSuggestions.ts.
 */
export type FileSuggestionCommandInput = {
  // Fields from createBaseHookInput (src/utils/hooks.ts)
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string

  /** The partial path the user has typed so far. May be empty. */
  query: string
}
