import test from 'ava'
import { stringLiteralContents, stripStringLiterals } from '../src/stringLiterals.ts'

test('returns the contents of single- and double-quoted strings, quotes stripped', t => {
  t.deepEqual(stringLiteralContents('const a = \'hello\'; const b = "world"'), ['hello', 'world'])
})

test('returns the contents of a template literal with no interpolation', t => {
  t.deepEqual(stringLiteralContents('const url = `https://api.example.com`'), ['https://api.example.com'])
})

test('excludes a template literal that interpolates a value', t => {
  t.deepEqual(stringLiteralContents('const greeting = `hello ${name}`'), [])
})

test('returns an empty array for a line with no string literal', t => {
  t.deepEqual(stringLiteralContents('const total = amount * 2'), [])
})

test('replaces a quoted string with spaces of the same length, keeping surrounding text and indices', t => {
  const source = 'x ? \'gold\' : \'silver\''
  const stripped = stripStringLiterals(source)

  t.is(stripped.length, source.length)
  t.true(stripped.startsWith('x ? '))
  t.true(stripped.includes(' : '))
  t.false(stripped.includes('gold'))
  t.false(stripped.includes('silver'))
})

test('leaves an interpolated template literal untouched', t => {
  const source = 'const greeting = `hello ${name}`'

  t.is(stripStringLiterals(source), source)
})

test('strips a non-interpolated template literal like any other string', t => {
  const source = 'const url = `fixed`'
  const stripped = stripStringLiterals(source)

  t.is(stripped.length, source.length)
  t.false(stripped.includes('fixed'))
})
