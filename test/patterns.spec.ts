import test from 'ava'
import { matchesAny } from '../src/patterns.ts'

test('returns true when at least one pattern matches the value', t => {
  const patterns = [/^fetch$/, /^axios\./]

  t.true(matchesAny(patterns, 'axios.get'))
})

test('returns false when no pattern matches the value', t => {
  const patterns = [/^fetch$/, /^axios\./]

  t.false(matchesAny(patterns, 'repo.save'))
})

test('returns false for an empty pattern list', t => {
  t.false(matchesAny([], 'anything'))
})
