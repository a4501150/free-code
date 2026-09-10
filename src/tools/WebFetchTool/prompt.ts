export const WEB_FETCH_TOOL_NAME = 'WebFetch'

export const DESCRIPTION = `
- Fetches a URL, converts HTML to markdown, and answers your prompt about the content using a small, fast model

Usage notes:
  - IMPORTANT: If an MCP-provided web fetch tool is available, prefer using that tool instead of this one, because it can have fewer restrictions.
  - The URL must be a fully-formed valid URL; HTTP URLs are upgraded to HTTPS automatically
  - The prompt must describe what information you want to extract from the page
  - When a URL redirects to a different host, the tool returns the redirect URL; make a new WebFetch request with it
  - For GitHub URLs, prefer using the gh CLI via Bash instead (for example, gh pr view, gh issue view, gh api).
`

export function makeSecondaryModelPrompt(
  markdownContent: string,
  prompt: string,
  isPreapprovedDomain: boolean,
): string {
  const guidelines = isPreapprovedDomain
    ? `Provide a concise response based on the content above. Include relevant details, code examples, and documentation excerpts as needed.`
    : `Provide a concise response based only on the content above.`

  return `
Web page content:
---
${markdownContent}
---

${prompt}

${guidelines}
`
}
