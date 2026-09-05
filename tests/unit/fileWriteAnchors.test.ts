/**
 * Write results must carry LINE:HASH anchors: a model that just wrote a
 * file has no real anchors to cite, and fabricates them (e.g. "22:00000")
 * into the next Edit. The block must not be budget-truncated: the whole
 * written file is the changed region.
 */
import { describe, test, expect } from 'bun:test'
import { FileWriteTool } from '../../src/tools/FileWriteTool/FileWriteTool.js'
import {
  computeHashlineLabels,
  formatAnchoredRegions,
} from '../../src/utils/hashline.js'

const content = `const a = 1\nconst b = 2\n`

describe('Write result anchors', () => {
  test('tool_result appends the anchor block after the success line', () => {
    const anchors = formatAnchoredRegions(
      content,
      [{ start: 1, count: 3 }],
      999,
    )
    const result = FileWriteTool.mapToolResultToToolResultBlockParam(
      {
        type: 'create',
        filePath: '/tmp/x.ts',
        content,
        structuredPatch: [],
        originalFile: null,
        changedRegionAnchors: anchors,
      },
      'tu_1',
    )
    const text = String((result as { content: string }).content)
    expect(text.startsWith('File created successfully at: /tmp/x.ts')).toBe(
      true,
    )
    expect(text).toContain('Anchors for the written lines.')
    expect(text).toMatch(/^1:[0-9a-z]+\|const a = 1$/m)
  })

  test('anchor labels match the labels a later Read would show', () => {
    const anchors = formatAnchoredRegions(
      content,
      [{ start: 1, count: 3 }],
      999,
    )
    const labels = computeHashlineLabels(content).labels.map(l => l.hash)
    expect(anchors).toContain(`1:${labels[0]}|const a = 1`)
    expect(anchors).toContain(`2:${labels[1]}|const b = 2`)
  })

  test('a file longer than the Edit budget is not truncated', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`)
    const big = lines.join('\n')
    const n = lines.length
    const anchors = formatAnchoredRegions(big, [{ start: 1, count: n }], n)
    expect(anchors).not.toContain('more changed lines not shown')
    expect(anchors).toContain(`200:`)
  })

  test('update result carries the block too', () => {
    const result = FileWriteTool.mapToolResultToToolResultBlockParam(
      {
        type: 'update',
        filePath: '/tmp/y.ts',
        content,
        structuredPatch: [],
        originalFile: 'old',
        changedRegionAnchors: '1:abc|const a = 1',
      },
      'tu_2',
    )
    const text = String((result as { content: string }).content)
    expect(
      text.startsWith('The file /tmp/y.ts has been updated successfully.'),
    ).toBe(true)
    expect(text).toContain('1:abc|const a = 1')
  })

  test('empty content yields no block', () => {
    const result = FileWriteTool.mapToolResultToToolResultBlockParam(
      {
        type: 'create',
        filePath: '/tmp/empty.ts',
        content: '',
        structuredPatch: [],
        originalFile: null,
      },
      'tu_3',
    )
    expect(String((result as { content: string }).content)).toBe(
      'File created successfully at: /tmp/empty.ts',
    )
  })
})
