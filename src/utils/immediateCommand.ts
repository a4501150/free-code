/**
 * Whether inference-config commands (/model, /fast, /effort) should execute
 * immediately (during a running query) rather than waiting for the current
 * turn to finish.
 */
export function shouldInferenceConfigCommandBeImmediate(): boolean {
  return true
}
