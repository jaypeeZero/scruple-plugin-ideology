import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import type { ChoiceAnswer, FunctionTarget, RuleCandidate } from '@scruple/core'
import { noHiddenState } from '../src/rules/noHiddenState.ts'
import { ideology } from '../src/index.ts'

const parser = oxcParser()

const fixtureCandidate = (): RuleCandidate => {
  const document = parser.parse('src/services/counter.ts', `
    let counter = 0

    function increment() {
      counter += 1
      return counter
    }
  `)
  const rule = noHiddenState()
  const [candidate] = rule.collect(document)
  return candidate
}

const choiceAnswer = (
  choice: string,
  probability: number,
  confidence: number
): ChoiceAnswer => ({
  type: 'choice',
  choice,
  confidence,
  probabilities: { [choice]: probability }
})

test('produces no candidates for a test file even with a referenced module-level let', t => {
  const source = `
    let counter = 0

    function increment() {
      counter += 1
      return counter
    }
  `
  const document = parser.parse('src/services/counter.spec.ts', source)
  const rule = noHiddenState()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces no candidates for a test-double file named with a Fakes, Doubles, Mocks, or Stubs suffix', t => {
  const source = `
    let counter = 0

    function increment() {
      counter += 1
      return counter
    }
  `
  const rule = noHiddenState()

  for (const filename of ['src/counterFakes.ts', 'src/counterDoubles.ts', 'src/counterMocks.ts', 'src/counterStubs.ts']) {
    t.deepEqual(rule.collect(parser.parse(filename, source)), [], filename)
  }
})

test('produces no candidates for a function referencing only its parameters and locals, with an unreferenced module-level let', t => {
  const source = `
    let counter = 0

    function describe(name) {
      const greeting = 'hello ' + name
      return greeting
    }
  `
  const document = parser.parse('src/services/greeter.ts', source)
  const rule = noHiddenState()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces one candidate for a function reading a module-level let counter', t => {
  const source = `
    let counter = 0

    function increment() {
      counter += 1
      return counter
    }
  `
  const document = parser.parse('src/services/counter.ts', source)
  const rule = noHiddenState()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { moduleBindings: string[] }
  t.true(state.moduleBindings.some(line => line.includes('let counter')))
})

test('produces one candidate for a function pushing into a module-level const registry array', t => {
  const source = `
    const registry = []

    function register(entry) {
      registry.push(entry)
      return registry
    }
  `
  const document = parser.parse('src/services/registry.ts', source)
  const rule = noHiddenState()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { moduleBindings: string[] }
  t.true(state.moduleBindings.some(line => line.includes('const registry')))
})

// The prefilter must not decide constant-vs-mutable itself; that judgment belongs
// to the model via `references_immutable_constant`, so a bare primitive const
// still produces a candidate.
test('produces one candidate for a function referencing a module-level primitive const MAX', t => {
  const source = `
    const MAX = 5

    function clamp(value) {
      return value > MAX ? MAX : value
    }
  `
  const document = parser.parse('src/services/clamp.ts', source)
  const rule = noHiddenState()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
})

test('positions the single candidate on the function that references module state', t => {
  const source = `
    let counter = 0

    function describe(name) {
      return 'hello ' + name
    }

    function increment() {
      counter += 1
      return counter
    }
  `
  const document = parser.parse('src/services/mixed.ts', source)
  const rule = noHiddenState()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as FunctionTarget).name, 'increment')
})

test('diagnose returns a warning at probability 0.90 with confidence 0.8', t => {
  const rule = noHiddenState()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('reads_or_writes_hidden_state', 0.90, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'warning')
})

test('diagnose returns an error at probability 0.96 with confidence 0.8', t => {
  const rule = noHiddenState()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('reads_or_writes_hidden_state', 0.96, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'error')
})

test('diagnose returns null below the warning threshold at probability 0.84', t => {
  const rule = noHiddenState()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('reads_or_writes_hidden_state', 0.84, 0.8), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null below minimum confidence at confidence 0.6', t => {
  const rule = noHiddenState()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('reads_or_writes_hidden_state', 0.96, 0.6), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the references_immutable_constant label', t => {
  const rule = noHiddenState()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('references_immutable_constant', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('offers the model exactly three labels, with no exception for caches', t => {
  const candidate = fixtureCandidate()

  const labels = candidate.question.type === 'choice' ? Object.keys(candidate.question.criteria).sort() : []

  t.deepEqual(labels, ['insufficient_context', 'reads_or_writes_hidden_state', 'references_immutable_constant'])
})

test('produces no candidates for a function that only calls module-level functions bound with const', t => {
  const source = `
    const helper = function (value) {
      return value * 2
    }
    const arrow = async (value) => value + 1
    export const outer = function (input) {
      return helper(input) + arrow(input)
    }
  `
  const document = parser.parse('src/services/math.ts', source)
  const rule = noHiddenState()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces exactly one candidate, positioned on the outer function, when a nested callback also references module state', t => {
  const source = `
    let counter = 0

    function incrementAll() {
      counter += 1
      const doubled = [1, 2, 3].map(function () {
        counter += 1
        return counter
      })
      return doubled
    }
  `
  const document = parser.parse('src/services/counterBatch.ts', source)
  const rule = noHiddenState()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as FunctionTarget).name, 'incrementAll')
})

test('registers no-hidden-state through the ideology plugin with a description', t => {
  const plugin = ideology()

  const rule = plugin.rules['no-hidden-state']()

  t.is(typeof rule.description, 'string')
  t.true(rule.description.length > 0)
})
