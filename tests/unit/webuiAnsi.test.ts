import { expect, test } from 'bun:test'
import { parseAnsi } from '../../src/webui/client/ansi'

const text = (s: ReturnType<typeof parseAnsi>): string =>
  s.map(seg => seg.text).join('')

test('SGR colors become styled segments, plain runs stay bare', () => {
  const segs = parseAnsi('a\x1b[33mwarning:\x1b[0m b')
  expect(text(segs)).toBe('awarning: b')
  expect(segs[0]).toEqual({ text: 'a' })
  expect(segs[1]!.style?.color).toBe('#a2734c')
  expect(segs[2]).toEqual({ text: ' b' })
})

test('bright, 256-color and truecolor codes resolve', () => {
  const segs = parseAnsi(
    '\x1b[91mbright\x1b[0m\x1b[38;5;208m256\x1b[0m\x1b[38;2;10;200;30mrgb\x1b[0m',
  )
  const styled = segs.filter(s => s.style)
  expect(text(segs)).toBe('bright256rgb')
  expect(styled[0]!.style?.color).toBe('#ef2929')
  expect(styled[1]!.style?.color).toBe('#ff8700')
  expect(styled[2]!.style?.color).toBe('rgb(10,200,30)')
})

test('non-SGR escapes and control characters produce no text', () => {
  const segs = parseAnsi('x\x1b[2K\x1b[1;1H\x1b]0;title\x07y\x08z')
  expect(text(segs)).toBe('xyz')
})

test('three-byte charset selects consume their final byte', () => {
  expect(text(parseAnsi('x\x1b(B[2Ky'))).toBe('x[2Ky')
  expect(text(parseAnsi('x\x1b(B\x1b[2Ky'))).toBe('xy')
})

test('CRLF folds to one newline, bare CR becomes a newline', () => {
  expect(text(parseAnsi('a\r\nb\rc'))).toBe('a\nb\nc')
})

test('a sequence cut at the stream tail is held out until it completes', () => {
  const half = parseAnsi('ok\x1b[3')
  expect(text(half)).toBe('ok')
  const full = parseAnsi('ok\x1b[33mred')
  expect(text(full)).toBe('okred')
  expect(full.at(-1)!.style?.color).toBe('#a2734c')
})

test('bold/dim/underline/inverse flags round-trip through resets', () => {
  const segs = parseAnsi('\x1b[1;4mB\x1b[0mP\x1b[7mI')
  expect(segs[0]!.style?.bold).toBe(true)
  expect(segs[0]!.style?.underline).toBe(true)
  expect(segs[1]).toEqual({ text: 'P' })
  expect(segs[2]!.style?.inverse).toBe(true)
})

test('emoji survive next to escapes', () => {
  const segs = parseAnsi('\x1b[32m✅\x1b[0m 🎉')
  expect(text(segs)).toBe('✅ 🎉')
})
