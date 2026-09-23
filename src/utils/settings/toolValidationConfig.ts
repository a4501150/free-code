/**
 * Tool validation configuration
 *
 * Most tools need NO configuration - basic validation works automatically.
 * Only add your tool here if it has special pattern requirements.
 */

export type ToolValidationConfig = {
  /** Tools that accept file glob patterns (e.g., *.ts, src/**) */
  filePatternTools: string[]

  /** Tools that accept bash wildcard patterns (* anywhere) and legacy :* prefix syntax */
  bashPrefixTools: string[]

  /** Custom validation rules for specific tools */
  customValidation: {
    [toolName: string]: (content: string) => {
      valid: boolean
      error?: string
      suggestion?: string
      examples?: string[]
    }
  }
}

export const TOOL_VALIDATION_CONFIG: ToolValidationConfig = {
  // File pattern tools (accept *.ts, src/**, etc.)
  filePatternTools: ['Read', 'Write', 'Edit'],

  // Bash wildcard tools (accept * anywhere, and legacy command:* syntax)
  bashPrefixTools: ['Bash'],

  // Custom validation (only if needed)
  customValidation: {},
}

// Helper to check if a tool uses file patterns
export function isFilePatternTool(toolName: string): boolean {
  return TOOL_VALIDATION_CONFIG.filePatternTools.includes(toolName)
}

// Helper to check if a tool uses bash prefix patterns
export function isBashPrefixTool(toolName: string): boolean {
  return TOOL_VALIDATION_CONFIG.bashPrefixTools.includes(toolName)
}

// Helper to get custom validation for a tool
export function getCustomValidation(toolName: string) {
  return TOOL_VALIDATION_CONFIG.customValidation[toolName]
}
