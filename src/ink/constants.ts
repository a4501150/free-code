// Shared frame interval for render throttling and animations (~60fps)
export const FRAME_INTERVAL_MS = 16

// Input-priority window: for this long after a keypress reaches the ink
// dispatcher, the frame pacer may run frames at INPUT_PRIORITY_FRAME_MS
// instead of FRAME_INTERVAL_MS. Typing latency is the most perceptually
// sensitive path, so we allow ~250fps frames briefly and pay the extra
// CPU only while keys are actually arriving. Same fast-frame cadence the
// scroll-drain re-arm uses.
export const INPUT_PRIORITY_WINDOW_MS = 50
export const INPUT_PRIORITY_FRAME_MS = FRAME_INTERVAL_MS >> 2
