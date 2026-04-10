export const SUBSCRIBE_PR_TOOL_NAME = 'SubscribePR'

export const DESCRIPTION = 'Subscribe to GitHub pull request events'

export const SUBSCRIBE_PR_TOOL_PROMPT = `Subscribe to events on a GitHub pull request. You will receive notifications when the PR is updated (new commits, comments, reviews, merge/close).

Use this when the user asks to watch or monitor a pull request, or when you need to track a PR's progress (e.g. waiting for CI to pass, waiting for review).

Requires the GitHub CLI (gh) to be installed and authenticated.

Events are delivered as <github-webhook-activity> messages during proactive tick check-ins.`
