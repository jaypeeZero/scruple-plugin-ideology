import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import { moduleScopeSource } from '../src/moduleScope.ts'

const parser = oxcParser()

test('returns the whole source for a file with no functions', t => {
  const source = `
    const MAX = 5
    let counter = 0
  `
  const document = parser.parse('src/services/constants.ts', source)

  t.is(moduleScopeSource(document), source)
})

test('excises a function body, leaving its declaration line behind', t => {
  const source = `
    let counter = 0

    function increment() {
      counter += 1
      return counter
    }
  `
  const document = parser.parse('src/services/counter.ts', source)

  const scope = moduleScopeSource(document)

  t.true(scope.includes('let counter = 0'))
  t.false(scope.includes('counter += 1'))
  t.false(scope.includes('return counter'))
})

test('keeps text between two functions', t => {
  const source = `
    function first() {
      return 1
    }

    const BETWEEN = 'kept'

    function second() {
      return 2
    }
  `
  const document = parser.parse('src/services/twoFunctions.ts', source)

  const scope = moduleScopeSource(document)

  t.true(scope.includes('const BETWEEN = \'kept\''))
  t.false(scope.includes('return 1'))
  t.false(scope.includes('return 2'))
})

test('does not double-excise when a function contains a nested function', t => {
  const source = `
    let counter = 0

    function outer() {
      counter += 1
      const inner = function () {
        return counter
      }
      return inner()
    }
  `
  const document = parser.parse('src/services/nested.ts', source)

  const scope = moduleScopeSource(document)

  t.true(scope.includes('let counter = 0'))
  t.false(scope.includes('counter += 1'))
  t.false(scope.includes('return inner()'))
})
