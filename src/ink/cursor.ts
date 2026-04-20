/**
 * Native-terminal cursor position, as carried on a rendered Frame
 * (see src/ink/frame.ts). Coordinates are 0-indexed, (0, 0) top-left.
 */
export type Cursor = {
  x: number
  y: number
  visible: boolean
}
