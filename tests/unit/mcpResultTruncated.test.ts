import { expect, test } from 'bun:test'
import { MCPTool } from '../../src/tools/MCPTool/MCPTool.js'

const long = 'line\n'.repeat(10)
test('long array results report truncated', () => {
  expect(
    MCPTool.isResultTruncated!([{ type: 'text', text: long }] as never),
  ).toBe(true)
})
test('short array results are not truncated', () => {
  expect(
    MCPTool.isResultTruncated!([{ type: 'text', text: 'ok' }] as never),
  ).toBe(false)
})
test('string results keep prior behavior', () => {
  expect(MCPTool.isResultTruncated!('short' as never)).toBe(false)
  expect(MCPTool.isResultTruncated!(long as never)).toBe(true)
})
