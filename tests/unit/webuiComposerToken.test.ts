import { expect, test } from 'bun:test'
import { completionToken } from '../../src/webui/client/components/Composer'

const at = (text: string) => completionToken(text, text.length)

test('slash tokens complete at the start and mid-message', () => {
  expect(at('/comp')).toBe('/comp')
  expect(at('please run /comp')).toBe('/comp')
  expect(at('use /review-pr and /sim')).toBe('/sim')
})

test('a slash inside a word is a path, not a token', () => {
  expect(at('see src/comp')).toBe('')
  expect(at('a/b')).toBe('')
})

test('the token follows the caret, not the end of input', () => {
  expect(completionToken('/comp please', 5)).toBe('/comp')
  expect(completionToken('run /sim now', 8)).toBe('/sim')
  // Caret past the token: nothing is being completed.
  expect(completionToken('/comp please', 6)).toBe('')
})

test('@ tokens complete at boundaries and skip emails', () => {
  expect(at('look at @src/')).toBe('@src/')
  expect(at('mail a@b')).toBe('')
})

test('a space ends the token', () => {
  expect(at('/compact now')).toBe('')
})
