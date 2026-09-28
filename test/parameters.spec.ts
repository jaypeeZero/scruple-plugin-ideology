import test from 'ava'
import { boundNames, parameterListText, splitTopLevelParams } from '../src/parameters.ts'

test('returns the text between the outer parens of a function declaration', t => {
  t.is(parameterListText('function total(items, rate) { return 1 }'), 'items, rate')
})

test('returns the text between the outer parens of a parenthesised arrow function', t => {
  t.is(parameterListText('(order, { page = 1 }) => order.total'), 'order, { page = 1 }')
})

test('returns the bare parameter of an arrow function with no parens', t => {
  t.is(parameterListText('order => order.total'), 'order ')
})

test('keeps nested parens inside a default value intact', t => {
  t.is(parameterListText('(count = Math.max(1, 2), label) => label'), 'count = Math.max(1, 2), label')
})

test('returns an empty string for source with neither parens nor an arrow', t => {
  t.is(parameterListText('const total = 42'), '')
})

test('returns everything after the open paren when the close paren is missing', t => {
  t.is(parameterListText('(items, rate'), 'items, rate')
})

test('splitTopLevelParams splits a plain parameter list on top-level commas', t => {
  t.deepEqual(splitTopLevelParams('items, rate'), ['items', ' rate'])
})

test('splitTopLevelParams keeps a nested object, array, or default-value literal intact', t => {
  t.deepEqual(splitTopLevelParams('{ a, b: [1, 2] }, count = Math.max(1, 2)'), [
    '{ a, b: [1, 2] }',
    ' count = Math.max(1, 2)'
  ])
})

test('splitTopLevelParams drops a trailing empty segment from a trailing comma', t => {
  t.deepEqual(splitTopLevelParams('a, b,'), ['a', ' b'])
})

test('splitTopLevelParams returns an empty array for an empty parameter list', t => {
  t.deepEqual(splitTopLevelParams(''), [])
})

test('boundNames returns the plain identifier for a simple parameter', t => {
  t.deepEqual(boundNames('order'), ['order'])
})

test('boundNames returns the plain identifier when a default value is present', t => {
  t.deepEqual(boundNames('count = 1'), ['count'])
})

test('boundNames returns shorthand object destructuring keys', t => {
  t.deepEqual(boundNames('{ page, size }'), ['page', 'size'])
})

test('boundNames returns the rename target, not the object key, for a renamed binding', t => {
  t.deepEqual(boundNames('{ a: b }'), ['b'])
})

test('boundNames returns array destructuring elements in position order', t => {
  t.deepEqual(boundNames('[first, second]'), ['first', 'second'])
})

test('boundNames returns the rest element name from an object pattern', t => {
  t.deepEqual(boundNames('{ a, ...rest }'), ['a', 'rest'])
})

test('boundNames recurses into a nested destructuring pattern', t => {
  t.deepEqual(boundNames('{ a: { b, c } }'), ['b', 'c'])
})
