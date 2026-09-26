/**
 * Pins the keyboard channel contract: the DOM tree gets every parsed key
 * BEFORE the 'input' emitter fires, and a keydown consumed by an onKeyDown
 * handler (stopPropagation / stopImmediatePropagation) suppresses the
 * emitter entirely so useInput listeners never see the handled key.
 *
 * Also pins FocusManager.defaultTarget: the fallback dispatch target when
 * activeElement is null (hosts register their live prompt container).
 */
import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'

import { createNode, type DOMElement } from '../../src/ink/dom.js'
import { FocusManager } from '../../src/ink/focus.js'
import type { ParsedKey } from '../../src/ink/parse-keypress.ts'

function key(name: string, overrides?: Partial<ParsedKey>): ParsedKey {
  return {
    kind: 'key',
    fn: false,
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    sequence: name === 'a' ? 'a' : `\x1b[${name}`,
    raw: undefined,
    isPasted: false,
    ...overrides,
  }
}

// Minimal stand-in for the App instance fields processKeysInBatch touches
// on the key path (cast — we only exercise the key branch).
function fakeApp(consumed: boolean) {
  const order: string[] = []
  const emitter = new EventEmitter()
  const inputs: unknown[] = []
  emitter.on('input', event => {
    order.push('input')
    inputs.push(event)
  })
  const app = {
    internal_eventEmitter: emitter,
    handleInput: () => {},
    querier: { onResponse: () => {} },
    props: {
      selection: { isDragging: false },
      dispatchKeyboardEvent: (_parsedKey: ParsedKey) => {
        order.push('tree')
        return consumed
      },
    },
  }
  return { app, order, inputs }
}

describe('keyboard channel order (tree before emitter, consumption suppresses)', () => {
  test('unconsumed keydown dispatches the tree first, then emits input', async () => {
    const { processKeysInBatch } =
      await import('../../src/ink/components/App.js')
    const { app, order, inputs } = fakeApp(false)
    processKeysInBatch(app as never, [key('a')], undefined, undefined)
    expect(order).toEqual(['tree', 'input'])
    expect(inputs).toHaveLength(1)
  })

  test('consumed keydown suppresses the input emit entirely', async () => {
    const { processKeysInBatch } =
      await import('../../src/ink/components/App.js')
    const { app, order, inputs } = fakeApp(true)
    processKeysInBatch(app as never, [key('a')], undefined, undefined)
    expect(order).toEqual(['tree'])
    expect(inputs).toHaveLength(0)
  })
})

describe('KeyboardEvent consumption flag', () => {
  test('propagationStopped reflects stopPropagation and stopImmediatePropagation', async () => {
    const { KeyboardEvent } =
      await import('../../src/ink/events/keyboard-event.js')
    const a = new KeyboardEvent(key('a'))
    expect(a.propagationStopped).toBe(false)
    a.preventDefault()
    expect(a.propagationStopped).toBe(false)
    a.stopPropagation()
    expect(a.propagationStopped).toBe(true)

    const b = new KeyboardEvent(key('a'))
    b.stopImmediatePropagation()
    expect(b.propagationStopped).toBe(true)
  })
})

describe('FocusManager.defaultTarget', () => {
  test('settable and readable, independent of activeElement', () => {
    const root = createNode('ink-root')
    const manager = new FocusManager(() => false)
    root.focusManager = manager
    const host = createNode('ink-box')

    expect(manager.defaultTarget).toBeNull()
    manager.setDefaultTarget(host)
    expect(manager.defaultTarget).toBe(host)

    // activeElement wins conceptually — defaultTarget stays untouched by focus changes
    manager.focus(host)
    expect(manager.activeElement).toBe(host)
    manager.blur()
    expect(manager.defaultTarget).toBe(host)

    manager.setDefaultTarget(null)
    expect(manager.defaultTarget).toBeNull()
  })

  test('node removal clears a detached defaultTarget', () => {
    const root = createNode('ink-root')
    const manager = new FocusManager(() => false)
    root.focusManager = manager
    const host = createNode('ink-box')
    root.childNodes.push(host)
    ;(host as DOMElement).parentNode = root

    manager.setDefaultTarget(host)
    // Detach, then simulate the reconciler removal notice.
    root.childNodes.splice(root.childNodes.indexOf(host), 1)
    ;(host as DOMElement).parentNode = undefined
    manager.handleNodeRemoved(host as DOMElement, root)

    expect(manager.defaultTarget).toBeNull()
  })
})
