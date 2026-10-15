/**
 * The local-jsx dialog handoff store: the non-React reducer behind the
 * hosted viewer's tool-JSX slot. The invariants that matter are the
 * REPL's own from useReplToolJSX: a local-jsx command owns the slot until
 * an explicit clearLocalJSX; non-clear writes cannot evict it; clear
 * releases both the latch and the render.
 */
import { describe, expect, test } from 'bun:test'
import { createLocalDialogStore } from '../../src/session/localDialogs.js'

const JSX_A = { type: 'div', key: 'a' } as never
const JSX_B = { type: 'div', key: 'b' } as never

describe('createLocalDialogStore', () => {
  test('a local-jsx write mounts the dialog; clearLocalJSX releases it', () => {
    const store = createLocalDialogStore()
    let notifications = 0
    const unsubscribe = store.subscribe(() => notifications++)

    store.set({
      jsx: JSX_A,
      shouldHidePromptInput: true,
      isLocalJSXCommand: true,
    })
    expect(store.snapshot()?.jsx).toBe(JSX_A)
    expect(notifications).toBe(1)

    // The pipeline's clear-on-completion write (handlePromptSubmit).
    store.set({
      jsx: null,
      shouldHidePromptInput: false,
      clearLocalJSX: true,
    })
    expect(store.snapshot()).toBeNull()
    expect(notifications).toBe(2)
    unsubscribe()
  })

  test('non-clear writes cannot evict a held local dialog', () => {
    const store = createLocalDialogStore()
    store.set({
      jsx: JSX_A,
      shouldHidePromptInput: true,
      isLocalJSXCommand: true,
    })
    // A stray progress-style update while the dialog is up: dropped, like
    // the REPL hook's local-command latch.
    store.set({ jsx: JSX_B, shouldHidePromptInput: false })
    expect(store.snapshot()?.jsx).toBe(JSX_A)
    // But it is NOT forgotten: after the clear, a plain write can mount.
    store.set({ jsx: null, shouldHidePromptInput: false, clearLocalJSX: true })
    store.set({ jsx: JSX_B, shouldHidePromptInput: false })
    expect(store.snapshot()?.jsx).toBe(JSX_B)
  })

  test('null clears without notifying an already-empty store', () => {
    const store = createLocalDialogStore()
    let notifications = 0
    store.subscribe(() => notifications++)
    store.set(null)
    expect(store.snapshot()).toBeNull()
    expect(notifications).toBe(0)
  })
})
