import test from 'ava'
import { parameterListText } from '../src/parameters.ts'

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
