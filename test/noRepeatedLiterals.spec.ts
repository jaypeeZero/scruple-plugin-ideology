import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import type { ChoiceAnswer, FunctionTarget, RuleCandidate } from '@scruple/core'
import { noRepeatedLiterals } from '../src/rules/noRepeatedLiterals.ts'
import { ideology } from '../src/index.ts'

const parser = oxcParser()

const fixtureCandidate = (): RuleCandidate => {
  const document = parser.parse('src/services/shipping.ts', `
    export const markShipped = (order) => {
      order.status = 'shipped'
      return order
    }

    export const isShipped = (order) => {
      return order.status === 'shipped'
    }
  `)
  const rule = noRepeatedLiterals()
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

test('produces no candidates for a test file even with a literal repeated across functions', t => {
  const source = `
    export const markShipped = (order) => {
      order.status = 'shipped'
      return order
    }

    export const isShipped = (order) => {
      return order.status === 'shipped'
    }
  `
  const document = parser.parse('src/services/shipping.spec.ts', source)
  const rule = noRepeatedLiterals()

  t.deepEqual(rule.collect(document), [])
})

test('positions the single candidate on the function with the first occurrence, listing every function and the total count', t => {
  const source = `
    export const markShipped = (order) => {
      order.status = 'shipped'
      return order
    }

    export const isShipped = (order) => {
      return order.status === 'shipped'
    }

    export const labelFor = (status) => {
      if (status === 'shipped') return 'Shipped'
      return 'Unknown'
    }
  `
  const document = parser.parse('src/services/shipping.ts', source)
  const rule = noRepeatedLiterals()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as FunctionTarget).name, 'markShipped')
  const state = candidates[0].state as { repeated: { literal: string, functions: string[], count: number }[] }
  t.is(state.repeated.length, 1)
  t.is(state.repeated[0].literal, 'shipped')
  t.deepEqual(state.repeated[0].functions, ['markShipped', 'isShipped', 'labelFor'])
  t.is(state.repeated[0].count, 3)
})

test('produces no candidates when the repeated literal already lives in a module-level constant', t => {
  const source = `
    const SHIPPED = 'shipped'

    export const markShipped = (order) => {
      order.status = SHIPPED
      return order
    }

    export const isShipped = (order) => {
      return order.status === SHIPPED
    }
  `
  const document = parser.parse('src/services/shippingConstant.ts', source)
  const rule = noRepeatedLiterals()

  t.deepEqual(rule.collect(document), [])
})

test('drops a literal repeated across functions when that same literal also appears in module scope', t => {
  const source = `
    const SHIPPED_LABEL = 'shipped'

    export const markShipped = (order) => {
      order.status = 'shipped'
      return order
    }

    export const isShipped = (order) => {
      return order.status === 'shipped'
    }
  `
  const document = parser.parse('src/services/shippingModuleLiteral.ts', source)
  const rule = noRepeatedLiterals()

  t.deepEqual(rule.collect(document), [])
})

test('a minFunctions option of 3 turns a two-function header repetition into no candidates', t => {
  const source = `
    export const withRequestId = (headers, id) => {
      headers['x-request-id'] = id
      return headers
    }

    export const readRequestId = (headers) => {
      return headers['x-request-id']
    }
  `
  const document = parser.parse('src/services/requestHeaders.ts', source)

  const defaultCandidates = noRepeatedLiterals().collect(document)
  t.is(defaultCandidates.length, 1)

  const strictCandidates = noRepeatedLiterals({ minFunctions: 3 }).collect(document)
  t.deepEqual(strictCandidates, [])
})

test('produces no candidates for structural literals repeated across functions', t => {
  const source = `
    export const first = () => {
      const empty = ''
      return empty + 1 + 0
    }

    export const second = () => {
      const empty = ''
      return empty + 0 + 1
    }
  `
  const document = parser.parse('src/services/structural.ts', source)
  const rule = noRepeatedLiterals()

  t.deepEqual(rule.collect(document), [])
})

test('produces no candidates for a literal repeated three times inside a single function', t => {
  const source = `
    export const describeShipment = (order) => {
      if (order.status === 'shipped') {
        console.log('shipped')
        return 'shipped'
      }
      return 'unknown'
    }
  `
  const document = parser.parse('src/services/describeShipment.ts', source)
  const rule = noRepeatedLiterals()

  t.deepEqual(rule.collect(document), [])
})

test('produces two candidates when two evidence groups have different first-occurrence functions', t => {
  const source = `
    export const f1 = (tier) => {
      if (tier === 'gold') return 'Gold tier'
      return 'unknown-tier'
    }

    export const f2 = (tier) => {
      if (tier === 'silver') return 'Silver tier'
      return 'unrecognized-tier'
    }

    export const f3 = (tier) => {
      return tier === 'gold' || tier === 'silver'
    }
  `
  const document = parser.parse('src/services/tierLabels.ts', source)
  const rule = noRepeatedLiterals()

  const candidates = rule.collect(document)

  t.is(candidates.length, 2)
  t.deepEqual(candidates.map((candidate) => (candidate.target as FunctionTarget).name), ['f1', 'f2'])
})

test('diagnose returns a warning at probability 0.90 with confidence 0.8', t => {
  const rule = noRepeatedLiterals()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('repeated_meaningful_literal', 0.90, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'warning')
})

test('diagnose returns an error at probability 0.96 with confidence 0.8', t => {
  const rule = noRepeatedLiterals()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('repeated_meaningful_literal', 0.96, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'error')
})

test('diagnose returns null below the warning threshold at probability 0.84', t => {
  const rule = noRepeatedLiterals()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('repeated_meaningful_literal', 0.84, 0.8), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null below minimum confidence at confidence 0.6', t => {
  const rule = noRepeatedLiterals()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('repeated_meaningful_literal', 0.96, 0.6), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the coincidental_or_structural label', t => {
  const rule = noRepeatedLiterals()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('coincidental_or_structural', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for a wrong answer type', t => {
  const rule = noRepeatedLiterals()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose({ type: 'noul', noul: 0.99 }, candidate)

  t.is(diagnostic, null)
})

test('offers the model exactly three labels', t => {
  const candidate = fixtureCandidate()

  const labels = candidate.question.type === 'choice' ? Object.keys(candidate.question.criteria).sort() : []

  t.deepEqual(labels, ['coincidental_or_structural', 'insufficient_context', 'repeated_meaningful_literal'])
})

test('registers no-repeated-literals through the ideology plugin with a description', t => {
  const plugin = ideology()

  const rule = plugin.rules['no-repeated-literals']()

  t.is(typeof rule.description, 'string')
  t.true(rule.description.length > 0)
})
