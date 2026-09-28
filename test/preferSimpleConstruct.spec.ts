import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import type { ChoiceAnswer, FunctionTarget, RuleCandidate } from '@scruple/core'
import { preferSimpleConstruct } from '../src/rules/preferSimpleConstruct.ts'
import { ideology } from '../src/index.ts'

const parser = oxcParser()

const fixtureCandidate = (): RuleCandidate => {
  const document = parser.parse('src/services/hasEmail.ts', `
    export const hasEmail = (user) => {
      return !!user.email
    }
  `)
  const rule = preferSimpleConstruct()
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

test('produces no candidates for a test file even with a nested ternary', t => {
  const source = `
    export const tierFor = (spend) => {
      const tier = spend > 1000 ? 'gold' : spend > 500 ? 'silver' : 'bronze'
      return tier
    }
  `
  const document = parser.parse('src/services/tiers.spec.ts', source)
  const rule = preferSimpleConstruct()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces no candidates for a function with a loop region, even with a nested ternary inside it', t => {
  const source = `
    export const labelsFor = (items) => {
      const labels = []
      for (const item of items) {
        labels.push(item.tier > 1000 ? 'gold' : item.tier > 500 ? 'silver' : 'bronze')
      }
      return labels
    }
  `
  const document = parser.parse('src/services/loopAndTernary.ts', source)
  const rule = preferSimpleConstruct()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces one candidate with kind nested-ternary for a chained ternary', t => {
  const source = `
    export const tierFor = (spend) => {
      const tier = spend > 1000 ? 'gold' : spend > 500 ? 'silver' : spend > 100 ? 'bronze' : 'none'
      return tier
    }
  `
  const document = parser.parse('src/services/tiers.ts', source)
  const rule = preferSimpleConstruct()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { constructs: { kind: string, source: string }[] }
  t.is(state.constructs[0].kind, 'nested-ternary')
})

test('produces no candidates for a single-level ternary', t => {
  const source = `
    export const labelFor = (active) => {
      return active ? 'Active' : 'Inactive'
    }
  `
  const document = parser.parse('src/services/labelFor.ts', source)
  const rule = preferSimpleConstruct()

  t.deepEqual(rule.collect(document), [])
})

test('produces one candidate with kind reduce-to-collection for a reduce building an object', t => {
  const source = `
    export const indexById = (items) => {
      return items.reduce((acc, i) => {
        acc[i.id] = i
        return acc
      }, {})
    }
  `
  const document = parser.parse('src/services/indexById.ts', source)
  const rule = preferSimpleConstruct()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { constructs: { kind: string }[] }
  t.is(state.constructs[0].kind, 'reduce-to-collection')
})

test('produces one candidate with kind reduce-to-collection for a reduce building a Map', t => {
  const source = `
    export const groupByKey = (items) => {
      return items.reduce((m, i) => m.set(i.key, [...(m.get(i.key) ?? []), i]), new Map())
    }
  `
  const document = parser.parse('src/services/groupByKey.ts', source)
  const rule = preferSimpleConstruct()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { constructs: { kind: string }[] }
  t.is(state.constructs[0].kind, 'reduce-to-collection')
})

test('produces no candidates for a reduce folding to a scalar with a numeric initial value', t => {
  const source = `
    export const totalOf = (items) => {
      return items.reduce((sum, i) => sum + i.amount, 0)
    }
  `
  const document = parser.parse('src/services/totalOf.ts', source)
  const rule = preferSimpleConstruct()

  t.deepEqual(rule.collect(document), [])
})

test('produces one candidate with kind regex-for-string-op for a plain anchored regex literal', t => {
  const source = `
    export const isSecure = (url) => {
      return /^https:/.test(url)
    }
  `
  const document = parser.parse('src/services/isSecure.ts', source)
  const rule = preferSimpleConstruct()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { constructs: { kind: string }[] }
  t.is(state.constructs[0].kind, 'regex-for-string-op')
})

test('produces no candidates for a regex with real character classes and alternation', t => {
  const source = `
    export const isEmail = (value) => {
      return /^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(value)
    }
  `
  const document = parser.parse('src/services/isEmail.ts', source)
  const rule = preferSimpleConstruct()

  t.deepEqual(rule.collect(document), [])
})

test('produces one candidate with kind bitwise-trick for a double bitwise NOT', t => {
  const source = `
    export const toCents = (amount) => {
      const cents = ~~(amount * 100)
      return cents
    }
  `
  const document = parser.parse('src/services/toCents.ts', source)
  const rule = preferSimpleConstruct()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { constructs: { kind: string }[] }
  t.is(state.constructs[0].kind, 'bitwise-trick')
})

test('produces one candidate with kind bitwise-trick for double negation', t => {
  const candidate = fixtureCandidate()

  const state = candidate.state as { constructs: { kind: string }[] }
  t.is(state.constructs[0].kind, 'bitwise-trick')
})

test('produces one candidate with kind bitwise-trick for a real bit-flag check', t => {
  const source = `
    export const canWrite = (permissions) => {
      return (permissions & WRITE) !== 0
    }
  `
  const document = parser.parse('src/services/canWrite.ts', source)
  const rule = preferSimpleConstruct()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { constructs: { kind: string }[] }
  t.is(state.constructs[0].kind, 'bitwise-trick')
})

test('produces one candidate with kind meta-programming for eval', t => {
  const source = `
    export const evaluateFormula = (expression) => {
      return eval(expression)
    }
  `
  const document = parser.parse('src/services/evaluateFormula.ts', source)
  const rule = preferSimpleConstruct()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { constructs: { kind: string }[] }
  t.is(state.constructs[0].kind, 'meta-programming')
})

test('positions the single candidate on the function using the clever construct', t => {
  const source = `
    export const describe = (name) => {
      return 'hello ' + name
    }

    export const hasEmail = (user) => {
      return !!user.email
    }
  `
  const document = parser.parse('src/services/mixed.ts', source)
  const rule = preferSimpleConstruct()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as FunctionTarget).name, 'hasEmail')
})

test('diagnose returns a warning at probability 0.90 with confidence 0.8', t => {
  const rule = preferSimpleConstruct()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('clever_where_simple_suffices', 0.90, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'warning')
})

test('diagnose returns an error at probability 0.96 with confidence 0.8', t => {
  const rule = preferSimpleConstruct()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('clever_where_simple_suffices', 0.96, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'error')
})

test('diagnose returns null below the warning threshold at probability 0.84', t => {
  const rule = preferSimpleConstruct()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('clever_where_simple_suffices', 0.84, 0.8), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null below minimum confidence at confidence 0.6', t => {
  const rule = preferSimpleConstruct()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('clever_where_simple_suffices', 0.96, 0.6), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the simplest_correct_option label', t => {
  const rule = preferSimpleConstruct()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('simplest_correct_option', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the performance_or_compat_justified_inline label', t => {
  const rule = preferSimpleConstruct()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('performance_or_compat_justified_inline', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('offers the model exactly four labels', t => {
  const candidate = fixtureCandidate()

  const labels = candidate.question.type === 'choice' ? Object.keys(candidate.question.criteria).sort() : []

  t.deepEqual(labels, [
    'clever_where_simple_suffices',
    'insufficient_context',
    'performance_or_compat_justified_inline',
    'simplest_correct_option'
  ])
})

test('registers prefer-simple-construct through the ideology plugin with a description', t => {
  const plugin = ideology()

  const rule = plugin.rules['prefer-simple-construct']()

  t.is(typeof rule.description, 'string')
  t.true(rule.description.length > 0)
})
