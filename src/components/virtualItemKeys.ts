import type { RenderableMessage } from '../types/message.js'

export type ItemKeyCache = {
  keys: string[]
  uuids: string[]
  itemKey: ((msg: RenderableMessage) => string) | null
}

export function createItemKeyCache(): ItemKeyCache {
  return { keys: [], uuids: [], itemKey: null }
}

/**
 * Incremental key array for the virtual list. Streaming appends one message at
 * a time, and rebuilding every key string per commit allocates ~2MB at 27k
 * messages, so a still-valid prefix is kept and only the tail is built.
 *
 * The prefix is validated by uuid rather than by object identity, because
 * normalizeMessages rebuilds every message object on each recompute. `itemKey`
 * must therefore derive from `msg.uuid` alone — anything else it reads has to
 * change the function's identity, which forces a rebuild.
 *
 * The validation is what keeps the keys aligned with the messages. The list is
 * not append-only: reorderMessagesInUI moves a tool_result up beside its
 * tool_use, so parallel calls that finish out of order insert a row before the
 * tail, and a collapse or a streaming placeholder can replace a row in place.
 * An unvalidated append shifted every later key by one and repeated the last
 * key, which gave two rows one React key, one cached height and one measured
 * element.
 */
export function syncItemKeys(
  cache: ItemKeyCache,
  messages: readonly RenderableMessage[],
  itemKey: (msg: RenderableMessage) => string,
): string[] {
  const retained = cache.uuids.length
  let reusable = cache.itemKey === itemKey && messages.length >= retained
  if (reusable) {
    for (let i = 0; i < retained; i++) {
      if (messages[i]!.uuid !== cache.uuids[i]) {
        reusable = false
        break
      }
    }
  }
  if (reusable) {
    for (let i = retained; i < messages.length; i++) {
      cache.keys.push(itemKey(messages[i]!))
      cache.uuids.push(messages[i]!.uuid)
    }
  } else {
    cache.keys = messages.map(m => itemKey(m))
    cache.uuids = messages.map(m => m.uuid)
  }
  cache.itemKey = itemKey
  return cache.keys
}
