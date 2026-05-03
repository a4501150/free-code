/**
 * Categorizes the origin of a model query for analytics, hook routing,
 * caching decisions, and prompt-specific behavior.
 *
 * Open-ended via `(string & {})` because src/utils/promptCategory.ts
 * synthesizes `agent:builtin:${agentType}` with `as QuerySource`.
 */
export type QuerySource =
  | 'user'
  | 'sdk'
  | 'repl_main_thread'
  | 'agent:default'
  | 'agent:custom'
  | `agent:builtin:${string}`
  | 'compact'
  | 'auto_dream'
  | 'auto_mode'
  | 'auto_mode_critique'
  | 'away_summary'
  | 'bash_extract_prefix'
  | 'extract_memories'
  | 'feedback'
  | 'generate_session_title'
  | 'hook_agent'
  | 'hook_prompt'
  | 'insights'
  | 'magic_docs'
  | 'mcp_datetime_parse'
  | 'memdir_relevance'
  | 'model_validation'
  | 'permission_explainer'
  | 'prompt_suggestion'
  | 'rename_generate_name'
  | 'session_memory'
  | 'session_search'
  | 'side_question'
  | 'skill_improvement_apply'
  | 'speculation'
  | 'tool_use_summary_generation'
  | 'web_fetch_apply'
  | 'web_search_tool'
  | 'verification_agent'
  | 'unknown'
  | 'agent_creation'
  | 'agent_summary'
  // eslint-disable-next-line @typescript-eslint/ban-types
  | (string & {})
