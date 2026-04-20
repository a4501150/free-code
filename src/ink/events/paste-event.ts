import { Event } from './event.js'

/**
 * Bracketed-paste event. Fired when the terminal delivers text inside
 * ESC[200~ / ESC[201~ markers.
 */
export class PasteEvent extends Event {
  /** The pasted text, with terminal bracketed-paste markers stripped. */
  readonly data: string

  constructor(data: string) {
    super()
    this.data = data
  }
}
