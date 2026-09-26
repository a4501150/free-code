import { toRGBColor } from '../Spinner/utils.js'

const SWEEP_DURATION_MS = 1500
const SWEEP_COUNT = 2
const TOTAL_ANIMATION_MS = SWEEP_DURATION_MS * SWEEP_COUNT
const SETTLED_GREY = toRGBColor({ r: 153, g: 153, b: 153 })
