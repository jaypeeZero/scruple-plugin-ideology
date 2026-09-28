import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import type { ChoiceAnswer, FunctionTarget, RuleCandidate } from '@scruple/core'
import { preferComposition } from '../src/rules/preferComposition.ts'
import { ideology } from '../src/index.ts'

const parser = oxcParser()

const fixtureCandidate = (): RuleCandidate => {
  const document = parser.parse('src/services/slug.ts', `
    export const slugify = (input) => {
      let s = input
      s = s.trim()
      s = s.toLowerCase()
      s = s.replace(/\\s+/g, '-')
      s = s.slice(0, 40)
      return s
    }
  `)
  const rule = preferComposition()
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

test('produces no candidates for a test file even with a qualifying reassignment chain', t => {
  const source = `
    export const slugify = (input) => {
      let s = input
      s = s.trim()
      s = s.toLowerCase()
      s = s.replace(/\\s+/g, '-')
      s = s.slice(0, 40)
      return s
    }
  `
  const document = parser.parse('src/services/slug.spec.ts', source)
  const rule = preferComposition()

  t.deepEqual(rule.collect(document), [])
})

test('produces one candidate for a let reassignment chain at the default minSteps', t => {
  const source = `
    export const slugify = (input) => {
      let s = input
      s = s.trim()
      s = s.toLowerCase()
      s = s.replace(/\\s+/g, '-')
      s = s.slice(0, 40)
      return s
    }
  `
  const document = parser.parse('src/services/slug.ts', source)
  const rule = preferComposition()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { chains: { kind: string, steps: number }[] }
  t.is(state.chains.length, 1)
  t.is(state.chains[0].kind, 'reassignment')
  t.true(state.chains[0].steps >= 3)
})

test('produces one candidate for a const chain where each initializer references the previous binding', t => {
  const source = `
    export const process = (raw) => {
      const parsed = Number(raw)
      const doubled = parsed * 2
      const clamped = Math.min(doubled, 100)
      const label = \`Result: \${clamped}\`
      return label
    }
  `
  const document = parser.parse('src/services/process.ts', source)
  const rule = preferComposition()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { chains: { kind: string, steps: number }[] }
  t.is(state.chains.length, 1)
  t.is(state.chains[0].kind, 'reassignment')
  t.true(state.chains[0].steps >= 3)
})

test('produces no candidates for const declarations that each reference the parameter instead of the previous binding', t => {
  const source = `
    export const buildSummary = (order) => {
      const id = order.id
      const total = order.total
      const status = order.status
      const createdAt = order.createdAt
      return { id, total, status, createdAt }
    }
  `
  const document = parser.parse('src/services/buildSummary.ts', source)
  const rule = preferComposition()

  t.deepEqual(rule.collect(document), [])
})

test('produces one candidate for a call pyramid at the default minNesting', t => {
  const source = `
    export const transform = (raw) => {
      const parse = (value) => Number(value)
      const double = (value) => value * 2
      const clamp = (value) => Math.min(value, 100)
      const toString = (value) => \`Result: \${value}\`
      return toString(clamp(double(parse(raw))))
    }
  `
  const document = parser.parse('src/services/transform.ts', source)
  const rule = preferComposition()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { chains: { kind: string, steps: number }[] }
  t.is(state.chains.length, 1)
  t.is(state.chains[0].kind, 'pyramid')
  t.true(state.chains[0].steps >= 4)
})

test('produces no candidates for a call pyramid three levels deep, one below the default minNesting', t => {
  const source = `
    export const parse = (raw) => Number(raw)
    export const double = (value) => value * 2
    export const toString = (value) => \`Result: \${value}\`
    export const process = (raw) => toString(double(parse(raw)))
  `
  const document = parser.parse('src/services/math.ts', source)
  const rule = preferComposition()

  t.deepEqual(rule.collect(document), [])
})

test('a minNesting option of 3 turns the three-level call pyramid into a candidate', t => {
  const source = `
    export const parse = (raw) => Number(raw)
    export const double = (value) => value * 2
    export const toString = (value) => \`Result: \${value}\`
    export const process = (raw) => toString(double(parse(raw)))
  `
  const document = parser.parse('src/services/math.ts', source)

  t.deepEqual(preferComposition().collect(document), [])

  const candidates = preferComposition({ minNesting: 3 }).collect(document)
  t.is(candidates.length, 1)
  const state = candidates[0].state as { chains: { kind: string, steps: number }[] }
  t.is(state.chains[0].kind, 'pyramid')
  t.is(state.chains[0].steps, 3)
})

test('produces one candidate for a method chain at the default minChain', t => {
  const source = `
    export const topTen = (items) => {
      return items
        .filter(x => x.active)
        .map(x => x.value)
        .filter(x => x > 0)
        .sort((a, b) => a - b)
        .slice(0, 10)
    }
  `
  const document = parser.parse('src/services/topTen.ts', source)
  const rule = preferComposition()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { chains: { kind: string, steps: number }[] }
  t.is(state.chains.length, 1)
  t.is(state.chains[0].kind, 'method-chain')
  t.true(state.chains[0].steps >= 5)
})

test('produces no candidates for a method chain four calls long, one below the default minChain', t => {
  const source = `
    export const topFour = (items) => {
      return items
        .filter(x => x.active)
        .map(x => x.value)
        .filter(x => x > 0)
        .sort((a, b) => a - b)
    }
  `
  const document = parser.parse('src/services/topFour.ts', source)
  const rule = preferComposition()

  t.deepEqual(rule.collect(document), [])
})

test('a minChain option of 4 turns the four-call method chain into a candidate', t => {
  const source = `
    export const topFour = (items) => {
      return items
        .filter(x => x.active)
        .map(x => x.value)
        .filter(x => x > 0)
        .sort((a, b) => a - b)
    }
  `
  const document = parser.parse('src/services/topFour.ts', source)

  t.deepEqual(preferComposition().collect(document), [])

  const candidates = preferComposition({ minChain: 4 }).collect(document)
  t.is(candidates.length, 1)
  const state = candidates[0].state as { chains: { kind: string, steps: number }[] }
  t.is(state.chains[0].kind, 'method-chain')
  t.is(state.chains[0].steps, 4)
})

test('produces no candidates for two reassignments below the default minSteps', t => {
  const source = `
    export const tokens = (raw) => {
      let v = raw.trim()
      v = v.toLowerCase()
      return v.split(',')
    }
  `
  const document = parser.parse('src/services/tokens.ts', source)
  const rule = preferComposition()

  t.deepEqual(rule.collect(document), [])
})

test('a minSteps option of 2 turns the two-reassignment chain into a candidate', t => {
  const source = `
    export const tokens = (raw) => {
      let v = raw.trim()
      v = v.toLowerCase()
      return v.split(',')
    }
  `
  const document = parser.parse('src/services/tokens.ts', source)

  t.deepEqual(preferComposition().collect(document), [])

  const candidates = preferComposition({ minSteps: 2 }).collect(document)
  t.is(candidates.length, 1)
  const state = candidates[0].state as { chains: { kind: string, steps: number }[] }
  t.is(state.chains[0].kind, 'reassignment')
})

test('produces no candidates for a function containing a loop region even with a qualifying const chain', t => {
  const source = `
    export const loopChain = (raw) => {
      const parsed = Number(raw)
      const doubled = parsed * 2
      const clamped = Math.min(doubled, 100)
      for (const x of [1, 2, 3]) {
        console.log(x)
      }
      return clamped
    }
  `
  const document = parser.parse('src/services/loopChain.ts', source)
  const rule = preferComposition()

  t.deepEqual(rule.collect(document), [])
})

test('produces no candidates for two steps computing one formula', t => {
  const source = `
    export const withTax = (net, rate) => {
      const gross = net * (1 + rate)
      const rounded = Math.round(gross * 100) / 100
      return rounded
    }
  `
  const document = parser.parse('src/services/withTax.ts', source)
  const rule = preferComposition()

  t.deepEqual(rule.collect(document), [])
})

test('positions the single candidate on the function with the reassignment chain', t => {
  const source = `
    export const describe = (name) => {
      return 'hello ' + name
    }

    export const slugify = (input) => {
      let s = input
      s = s.trim()
      s = s.toLowerCase()
      s = s.replace(/\\s+/g, '-')
      s = s.slice(0, 40)
      return s
    }
  `
  const document = parser.parse('src/services/mixed.ts', source)
  const rule = preferComposition()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as FunctionTarget).name, 'slugify')
})

test('diagnose returns a warning at probability 0.90 with confidence 0.8', t => {
  const rule = preferComposition()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('inlines_composable_steps', 0.90, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'warning')
})

test('diagnose returns an error at probability 0.96 with confidence 0.8', t => {
  const rule = preferComposition()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('inlines_composable_steps', 0.96, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'error')
})

test('diagnose returns null below the warning threshold at probability 0.84', t => {
  const rule = preferComposition()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('inlines_composable_steps', 0.84, 0.8), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null below minimum confidence at confidence 0.6', t => {
  const rule = preferComposition()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('inlines_composable_steps', 0.96, 0.6), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the steps_are_one_transformation label', t => {
  const rule = preferComposition()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('steps_are_one_transformation', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the already_composed label', t => {
  const rule = preferComposition()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('already_composed', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('offers the model exactly four labels', t => {
  const candidate = fixtureCandidate()

  const labels = candidate.question.type === 'choice' ? Object.keys(candidate.question.criteria).sort() : []

  t.deepEqual(labels, [
    'already_composed',
    'inlines_composable_steps',
    'insufficient_context',
    'steps_are_one_transformation'
  ])
})

test('registers prefer-composition through the ideology plugin with a description', t => {
  const plugin = ideology()

  const rule = plugin.rules['prefer-composition']()

  t.is(typeof rule.description, 'string')
  t.true(rule.description.length > 0)
})
