export {}

// Augment React's JSX IntrinsicElements to include ink's custom host elements.
// These are rendered directly by ink's reconciler (not via React DOM).
import 'react'

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'ink-box': Record<string, unknown>
      'ink-text': Record<string, unknown>
      'ink-link': Record<string, unknown>
      'ink-raw-ansi': Record<string, unknown>
    }
  }
}
