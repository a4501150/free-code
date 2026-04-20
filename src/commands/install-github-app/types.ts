/**
 * Types for the /install-github-app setup flow. Shapes derived from
 * INITIAL_STATE and every `setState(prev => ({ ...prev, ... }))` call
 * in install-github-app.tsx.
 */

export type Workflow = 'claude' | 'claude-review' | string

/**
 * A pre-install warning (missing CLI, missing permissions, …) shown on
 * the WarningsStep.
 */
export type Warning = {
  title: string
  message: string
  instructions?: string[]
}

/** Step the wizard is currently displaying. */
export type WizardStep =
  | 'check-gh'
  | 'warnings'
  | 'choose-repo'
  | 'install-app'
  | 'check-existing-workflow'
  | 'select-workflows'
  | 'check-existing-secret'
  | 'api-key'
  | 'oauth-flow'
  | 'creating'
  | 'success'
  | 'error'

/**
 * Full wizard state — modified step-by-step with `setState(prev => ({…}))`.
 */
export type State = {
  step: WizardStep
  selectedRepoName: string
  currentRepo: string
  useCurrentRepo: boolean
  apiKeyOrOAuthToken: string
  useExistingKey: boolean
  currentWorkflowInstallStep: number
  warnings: Warning[]
  secretExists: boolean
  secretName: string
  useExistingSecret: boolean
  workflowExists: boolean
  selectedWorkflows: Workflow[]
  selectedApiKeyOption: 'existing' | 'new' | 'oauth'
  authType: 'api_key' | 'oauth' | 'oauth_token'
  workflowAction?: string
  errorReason?: string
  errorInstructions?: string[]
  error?: string
}
