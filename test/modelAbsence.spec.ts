import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import type { ChoiceAnswer, FunctionTarget, RuleCandidate } from '@scruple/core'
import { modelAbsence } from '../src/rules/modelAbsence.ts'
import { ideology } from '../src/index.ts'

const parser = oxcParser()

const fixtureCandidate = (): RuleCandidate => {
  const document = parser.parse('src/customers/customerGreeting.ts', `
    export const greet = (customer) => {
      const name = customer.name ?? ''
      return \`Hello, \${name}\`
    }
  `)
  const rule = modelAbsence()
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

test('produces no candidates for a test-double file, even with a nullish default', t => {
  const source = `
    export const greet = (customer) => {
      const name = customer.name ?? ''
      return name
    }
  `
  const document = parser.parse('src/customers/customerGreetingFakes.ts', source)
  const rule = modelAbsence()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces no candidates for a function with no ??, no literal ||, and no default parameter', t => {
  const source = `
    export const fullName = (first, last) => {
      return first + ' ' + last
    }
  `
  const document = parser.parse('src/customers/fullName.ts', source)
  const rule = modelAbsence()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces one candidate for const name = input.name ?? \'\', kind nullish, source containing the operator', t => {
  const source = `
    export const greet = (input) => {
      const name = input.name ?? ''
      return name
    }
  `
  const document = parser.parse('src/customers/customerGreeting.ts', source)
  const rule = modelAbsence()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { defaults: Array<{ kind: string, source: string }> }
  t.is(state.defaults[0].kind, 'nullish')
  t.true(state.defaults[0].source.includes('?? \'\''))
})

test('produces one candidate for const tags = input.tags || [], kind or', t => {
  const source = `
    export const tagsOf = (input) => {
      const tags = input.tags || []
      return tags
    }
  `
  const document = parser.parse('src/tags/tagsOf.ts', source)
  const rule = modelAbsence()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { defaults: Array<{ kind: string }> }
  t.is(state.defaults[0].kind, 'or')
})

test('produces no candidates for a || b where b is an identifier, not a literal default', t => {
  const source = `
    export const firstNonEmpty = (a, b) => {
      return a || b
    }
  `
  const document = parser.parse('src/values/firstNonEmpty.ts', source)
  const rule = modelAbsence()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces one candidate for (limit = 20) => ..., kind parameter, source containing the assignment', t => {
  const source = `
    export const pageOf = (limit = 20) => {
      return limit
    }
  `
  const document = parser.parse('src/paging/pageOf.ts', source)
  const rule = modelAbsence()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { defaults: Array<{ kind: string, source: string }> }
  t.is(state.defaults[0].kind, 'parameter')
  t.true(state.defaults[0].source.includes('limit = 20'))
})

test('produces exactly one candidate, positioned on the defaulting function, when a second function has none', t => {
  const source = `
    export const fullName = (first, last) => {
      return first + ' ' + last
    }

    export const greet = (input) => {
      const name = input.name ?? ''
      return name
    }
  `
  const document = parser.parse('src/customers/customerGreeting.ts', source)
  const rule = modelAbsence()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as FunctionTarget).name, 'greet')
})

test('produces exactly one candidate, positioned on the outer function, when a nested callback holds the ??', t => {
  const source = `
    export const greetAll = (customers) => {
      return customers.map(function (customer) {
        const name = customer.name ?? ''
        return name
      })
    }
  `
  const document = parser.parse('src/customers/greetAll.ts', source)
  const rule = modelAbsence()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as FunctionTarget).name, 'greetAll')
})

test('produces one candidate with two entries in state.defaults for a function with ?? and a default parameter', t => {
  const source = `
    export const pageOf = (input, limit = 20) => {
      const name = input.name ?? ''
      return { name, limit }
    }
  `
  const document = parser.parse('src/paging/pageOf.ts', source)
  const rule = modelAbsence()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { defaults: unknown[] }
  t.is(state.defaults.length, 2)
})

test('diagnose returns a warning at probability 0.90 with confidence 0.8', t => {
  const rule = modelAbsence()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('default_hides_missing_value', 0.90, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'warning')
})

test('diagnose returns an error at probability 0.96 with confidence 0.8', t => {
  const rule = modelAbsence()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('default_hides_missing_value', 0.96, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'error')
})

test('diagnose returns null below the warning threshold at probability 0.84', t => {
  const rule = modelAbsence()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('default_hides_missing_value', 0.84, 0.8), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null below minimum confidence at confidence 0.6', t => {
  const rule = modelAbsence()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('default_hides_missing_value', 0.96, 0.6), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the default_is_a_declared_option label', t => {
  const rule = modelAbsence()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('default_is_a_declared_option', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the absence_is_modelled label', t => {
  const rule = modelAbsence()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('absence_is_modelled', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('offers the model exactly four labels', t => {
  const candidate = fixtureCandidate()

  const labels = candidate.question.type === 'choice' ? Object.keys(candidate.question.criteria).sort() : []

  t.deepEqual(labels, [
    'absence_is_modelled',
    'default_hides_missing_value',
    'default_is_a_declared_option',
    'insufficient_context'
  ])
})

test('registers model-absence through the ideology plugin with a description', t => {
  const plugin = ideology()

  const rule = plugin.rules['model-absence']()

  t.is(typeof rule.description, 'string')
  t.true(rule.description.length > 0)
})
