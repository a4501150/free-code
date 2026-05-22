import { dlopen } from 'bun:ffi'

export type ModifierKey = 'shift' | 'command' | 'control' | 'option'

const CORE_GRAPHICS_PATH =
  '/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics'

const KCG_EVENT_SOURCE_STATE_COMBINED_SESSION_STATE = 0

const MODIFIER_KEY_CODES: Record<ModifierKey, readonly [number, number]> = {
  shift: [56, 60],
  option: [58, 61],
  control: [59, 62],
  command: [55, 54],
}

type CoreGraphicsLibrary = {
  symbols: {
    CGEventSourceKeyState: (stateID: number, key: number) => boolean
  }
}

let prewarmed = false
// undefined = not yet attempted, null = load failed
let lib: CoreGraphicsLibrary | null | undefined

function loadLibrary(): CoreGraphicsLibrary | null {
  if (process.platform !== 'darwin') return null
  if (lib !== undefined) return lib

  try {
    lib = dlopen(CORE_GRAPHICS_PATH, {
      CGEventSourceKeyState: {
        args: ['u32', 'u16'],
        returns: 'bool',
      },
    }) as CoreGraphicsLibrary
  } catch {
    lib = null
  }

  return lib
}

export function prewarmModifiers(): void {
  if (prewarmed || process.platform !== 'darwin') return
  prewarmed = true
  loadLibrary()
}

export function isModifierPressed(modifier: ModifierKey): boolean {
  try {
    const keyCodes = MODIFIER_KEY_CODES[modifier]
    const cg = loadLibrary()
    if (!cg) return false
    return keyCodes.some(code =>
      cg.symbols.CGEventSourceKeyState(
        KCG_EVENT_SOURCE_STATE_COMBINED_SESSION_STATE,
        code,
      ),
    )
  } catch {
    return false
  }
}
