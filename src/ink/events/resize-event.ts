import { Event } from './event.js'

/**
 * Terminal resize event. Fired when the process receives SIGWINCH (or
 * the equivalent ConnPTY signal) and the viewport dimensions change.
 */
export class ResizeEvent extends Event {
  readonly columns: number
  readonly rows: number

  constructor(columns: number, rows: number) {
    super()
    this.columns = columns
    this.rows = rows
  }
}
