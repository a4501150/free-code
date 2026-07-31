import { getAttributionTexts } from '../../utils/attribution.js'
import { shouldIncludeGitInstructions } from '../../utils/gitSettings.js'

export type MultiLineSyntax = {
  /** How to pass a multi-line commit message, e.g. "a HEREDOC (`...`)". */
  commit: string
  /** Shorter reference for the PR body line, e.g. "a HEREDOC". */
  pr: string
}

export function getCommitAndPRInstructions(syntax: MultiLineSyntax): string {
  if (!shouldIncludeGitInstructions()) return ''

  const { commit: commitFooter, pr: prFooter } = getAttributionTexts()

  const commitLine = `- For git commits, pass multi-line messages via ${syntax.commit} to preserve newlines and avoid shell-escaping issues.${
    commitFooter
      ? ` Include \`${commitFooter}\` at the end of the message.`
      : ''
  }`

  const prLine = `- For \`gh pr create\`, pass the body via ${syntax.pr} (same pattern).${
    prFooter ? ` End the body with \`${prFooter}\`.` : ''
  }`

  return `# Git commits and pull requests

- Use conventional commit format: \`type(scope): subject\` (e.g. \`feat(auth): add OAuth2 support\`, \`fix(api): handle null response\`).
${commitLine}
${prLine}`
}
