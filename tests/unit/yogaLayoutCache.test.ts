/**
 * Direct regression tests for the yoga port's cache stack
 * (src/native-ts/yoga-layout). Until now every cache-performance and
 * cache-CORRECTNESS property was only exercised indirectly through ink
 * (and the port's cited bench script no longer exists), so the three
 * staleness bugs fixed alongside these tests had no direct harness.
 *
 * Pinned behaviors:
 *   1. A flexGrow child tracks its parent's free space across viewport
 *      oscillation, even when the flex container is CLEAN (cache-hit
 *      only) between the changes — per-slot ring stamps, layout-hit
 *      serve-commits (_defW/_defH), and the clean-resize ring wipe.
 *   2. A layout pass never consumes a measure-mode entry: children keep
 *      being positioned even after the ring fills with measure entries.
 *   3. A parent's align-items change re-derives a clean child's flex
 *      basis (the fb cache keys on the stretch alignment it was computed
 *      under, since a parent style change doesn't dirty the child).
 */
import { describe, expect, test } from 'bun:test'

import Yoga, { Align, FlexDirection, MeasureMode } from '../../src/native-ts/yoga-layout/index.js'

type YogaNode = ReturnType<typeof Yoga.Node.create>

/**
 * Text-like leaf: occupies min(intrinsic, available) under AtMost and
 * the full constraint under Exactly (stretch), wrapping to
 * lineCount(occupiedWidth) lines.
 */
function makeLeaf(
  intrinsicWidth: number,
  lineCount: (atWidth: number) => number,
): YogaNode {
  const leaf = Yoga.Node.create()
  leaf.setMeasureFunc((width: number, mode: MeasureMode) => {
    const w =
      mode === MeasureMode.Exactly
        ? width
        : Math.max(1, Math.min(intrinsicWidth, width))
    return { width: w, height: lineCount(w) }
  })
  return leaf
}

describe('yoga port layout cache', () => {
  test('flexGrow child tracks viewport oscillation through clean cache hits', () => {
    // root(column, H) [ wrapper(flexGrow, clean) [ msg(h fixed), spacer ] ]
    // Oscillating H changes the wrapper's free space. The wrapper never
    // dirties — its correct sizes must come from fresh computation or
    // correctly-keyed cache hits, never from pre-oscillation entries.
    const root = Yoga.Node.create()
    root.setWidth(100)
    root.setFlexDirection(FlexDirection.Column)

    const wrapper = Yoga.Node.create()
    wrapper.setFlexDirection(FlexDirection.Column)
    wrapper.setFlexGrow(1)
    wrapper.setFlexShrink(0)

    const msg = Yoga.Node.create()
    msg.setHeight(10)

    const spacer = Yoga.Node.create()
    spacer.setFlexGrow(1)

    root.insertChild(wrapper, 0)
    wrapper.insertChild(msg, 0)
    wrapper.insertChild(spacer, 1)

    const expectSpacer = (h: number): void => {
      root.setHeight(h)
      root.calculateLayout(100)
      expect(spacer.getComputedHeight()).toBe(h - 10)
    }

    // 40 → 36 → 40 → 36: each revisit of a size must not serve the OTHER
    // size's entry, and clean skip-generations must not pin stale values.
    expectSpacer(40)
    expectSpacer(36)
    expectSpacer(40)
    expectSpacer(36)
    // Clean generation (no mutation at all): sizes hold.
    root.calculateLayout(100)
    expect(spacer.getComputedHeight()).toBe(36 - 10)
  })

  test('layout passes position children after the ring fills with measure entries', () => {
    // A measure-func leaf laid out repeatedly: computeFlexBasis measure
    // calls and STEP-5 layout calls hit the same node with different
    // modes. A layout call consuming a measure entry would skip the
    // child-positioning recursion and strand children at stale
    // coordinates.
    const root = Yoga.Node.create()
    root.setWidth(100)
    root.setHeight(20)
    root.setFlexDirection(FlexDirection.Column)

    const box = Yoga.Node.create()
    box.setFlexDirection(FlexDirection.Column)
    const leafA = makeLeaf(50, () => 2)
    const leafB = makeLeaf(50, () => 3)
    box.insertChild(leafA, 0)
    box.insertChild(leafB, 1)
    root.insertChild(box, 0)

    for (let gen = 0; gen < 6; gen++) {
      if (gen % 2 === 1) leafB.markDirty()
      root.calculateLayout(100)
      // Children must be positioned every generation: B starts directly
      // below A (plus its own top offset 0), never stranded at 0.
      const aTop = leafA.getComputedTop() ?? -1
      const bTop = leafB.getComputedTop() ?? -1
      expect(bTop).toBeGreaterThan(aTop)
      expect(aTop).toBeGreaterThanOrEqual(0)
    }
    expect(box.getComputedHeight()).toBe(5)
  })

  test('parent align-items change re-derives a clean child flex basis', () => {
    // Column parent, width 50. Child = text-like leaf: intrinsic width
    // 40, one line at width >= 45, two lines below. The leaf is never
    // dirtied by the parent's alignment flip — the fb cache must key
    // on the stretch alignment the basis was computed under and refuse
    // to serve it after the flip.
    //
    //   stretch (default): cross constraint Exactly 50 → leaf width 50
    //     → one line → spacer gets 20 - 1.
    //   flex-start: cross constraint AtMost 50 → leaf takes its
    //     intrinsic 40 → two lines → spacer gets 20 - 2.
    // A stale stretch-era basis (one line) is the bug: the spacer
    // would keep 19 after the flip.
    const root = Yoga.Node.create()
    root.setWidth(50)
    root.setHeight(20)
    root.setFlexDirection(FlexDirection.Column)

    const box = Yoga.Node.create()
    box.setFlexDirection(FlexDirection.Column)
    box.setFlexGrow(1)
    const leaf = makeLeaf(40, atWidth => (atWidth >= 45 ? 1 : 2))
    const spacer = Yoga.Node.create()
    spacer.setFlexGrow(1)
    box.insertChild(leaf, 0)
    box.insertChild(spacer, 1)
    root.insertChild(box, 0)

    root.calculateLayout(50)
    expect(leaf.getComputedWidth()).toBe(50)
    expect(leaf.getComputedHeight()).toBe(1)
    expect(spacer.getComputedHeight()).toBe(20 - 1)

    // Flip the parent's alignment: the leaf itself stays CLEAN, so its
    // cached basis must be re-keyed, not reused.
    box.setAlignItems(Align.FlexStart)
    root.calculateLayout(50)
    expect(leaf.getComputedWidth()).toBe(40)
    expect(leaf.getComputedHeight()).toBe(2)
    expect(spacer.getComputedHeight()).toBe(20 - 2)

    // Flip back: oscillation must not serve the flex-start-era basis
    // to the stretch pass either.
    box.setAlignItems(Align.Stretch)
    root.calculateLayout(50)
    expect(leaf.getComputedHeight()).toBe(1)
    expect(spacer.getComputedHeight()).toBe(20 - 1)
  })
})
