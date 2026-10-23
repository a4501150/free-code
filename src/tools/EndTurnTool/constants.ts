export const END_TURN_TOOL_NAME = 'EndTurn'

export const DESCRIPTION = `Signals that your work is complete and ends your run.
Your most recent text message is delivered to the caller as your final result, so write your report BEFORE or TOGETHER WITH this call — the tool takes no content.
Any background tasks you still own (backgrounded bash, monitors) are killed when you call this, so stop anything that must keep running, or keep waiting for it instead.
This is the ONLY way to finish your run: ending your message without tool calls does not end it — you will be asked again to either continue working or call this tool.`
