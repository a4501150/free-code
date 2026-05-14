import type { LocalCommandResult } from '../../commands.js'

import { openBrowser } from '../../utils/browser.js'

const SLACK_APP_URL = 'https://slack.com/marketplace/A08SF47R6P4-claude'

export async function call(): Promise<LocalCommandResult> {
  const success = await openBrowser(SLACK_APP_URL)

  if (success) {
    return {
      type: 'text',
      value: 'Opening Slack app installation page in browser…',
    }
  } else {
    return {
      type: 'text',
      value: `Couldn't open browser. Visit: ${SLACK_APP_URL}`,
    }
  }
}
