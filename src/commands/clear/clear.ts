import type { LocalCommandCall } from '../../types/command.js'
import { clearConversation } from './conversation.js'

export const call: LocalCommandCall = async (_, context) => {
  await clearConversation({
    ...context,
    // The headless/webGUI child has no messagesRef to hand over. The command
    // context's `messages` IS the runtime's live transcript array — both
    // QueryEngine and the print loop build the slash-command context with
    // `messages: mutableMessages` by reference, the same array the attach
    // runtime's getMessages() exposes (src/server/headlessBridge.ts).
    // clearConversation snapshots it synchronously before setMessages
    // replaces the array, so the outgoing /dream segment flush sees the
    // pre-clear conversation instead of an empty list.
    getMessages: () => context.messages,
  })
  return { type: 'text', value: '' }
}
