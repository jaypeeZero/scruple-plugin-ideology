import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import type { ChoiceAnswer, FunctionTarget, RuleCandidate } from '@scruple/core'
import { noDecisionsByOmission } from '../src/rules/noDecisionsByOmission.ts'
import { ideology } from '../src/index.ts'

const parser = oxcParser()

const fixtureCandidate = (): RuleCandidate => {
  const document = parser.parse('src/services/orderTotals.ts', `
    export const totalOf = (order) => {
      const total = (order as any).grandTotal
      return total
    }
  `)
  const rule = noDecisionsByOmission()
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

test('produces no candidates for a test file even with an as-any escape', t => {
  const source = `
    export const totalOf = (order) => {
      const total = (order as any).grandTotal
      return total
    }
  `
  const document = parser.parse('src/services/orderTotals.spec.ts', source)
  const rule = noDecisionsByOmission()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces one candidate for a function casting through any', t => {
  const source = `
    export const totalOf = (order) => {
      const total = (order as any).grandTotal
      return total
    }
  `
  const document = parser.parse('src/services/orderTotals.ts', source)
  const rule = noDecisionsByOmission()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { escapes: { kind: string; source: string }[] }
  t.deepEqual(state.escapes, [{ kind: 'type', source: 'const total = (order as any).grandTotal' }])
})

test('produces one candidate for a function silenced with a bare ts-ignore', t => {
  const source = `
    export const notify = (user) => {
      // @ts-ignore
      user.send()
    }
  `
  const document = parser.parse('src/services/notifier.ts', source)
  const rule = noDecisionsByOmission()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { escapes: { kind: string; source: string }[] }
  t.deepEqual(state.escapes, [{ kind: 'type', source: '// @ts-ignore' }])
})

test('produces one candidate for an eslint-disable with no stated reason', t => {
  const source = `
    export const parseRow = (row) => {
      // eslint-disable-next-line no-unused-vars
      const x = row
      return x
    }
  `
  const document = parser.parse('src/services/rowParser.ts', source)
  const rule = noDecisionsByOmission()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { escapes: { kind: string; source: string }[] }
  t.deepEqual(state.escapes, [{ kind: 'lint', source: '// eslint-disable-next-line no-unused-vars' }])
})

test('produces no candidates for an eslint-disable that states a reason after --', t => {
  const source = `
    export const parseRow = (row) => {
      // eslint-disable-next-line foo -- reason
      return row
    }
  `
  const document = parser.parse('src/services/rowParser.ts', source)
  const rule = noDecisionsByOmission()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces one candidate for a TODO standing in for the implementation', t => {
  const source = `
    export const refund = (order) => {
      // TODO: implement refunds
      return order
    }
  `
  const document = parser.parse('src/services/refunds.ts', source)
  const rule = noDecisionsByOmission()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { escapes: { kind: string; source: string }[] }
  t.deepEqual(state.escapes, [{ kind: 'deferred', source: '// TODO: implement refunds' }])
})

test('produces one candidate for a bare not-implemented throw', t => {
  const source = `
    export const cancel = (order) => {
      throw new Error('not implemented')
    }
  `
  const document = parser.parse('src/services/cancellations.ts', source)
  const rule = noDecisionsByOmission()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { escapes: { kind: string; source: string }[] }
  t.deepEqual(state.escapes, [{ kind: 'deferred', source: 'throw new Error(\'not implemented\')' }])
})

test('produces one candidate for a switch default that silently breaks', t => {
  const source = `
    export const labelFor = (status) => {
      switch (status) {
        case 'a':
          return 'Alpha'
        default:
          break
      }
    }
  `
  const document = parser.parse('src/services/statusLabels.ts', source)
  const rule = noDecisionsByOmission()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { escapes: { kind: string; source: string }[] }
  t.deepEqual(state.escapes, [{ kind: 'deferred', source: 'default:' }])
})

test('produces no candidates for a switch default that opens a block and throws on the exhaustiveness check', t => {
  const source = `
    export const labelFor = (status) => {
      switch (status) {
        case 'a':
          return 'Alpha'
        default: {
          const _exhaustive = status
          throw new Error('unhandled status')
        }
      }
    }
  `
  const document = parser.parse('src/services/statusExhaustive.ts', source)
  const rule = noDecisionsByOmission()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces no candidates for as-unknown alone with no further cast', t => {
  const source = `
    export const identity = (value) => {
      const result = value as unknown
      return result
    }
  `
  const document = parser.parse('src/services/asUnknownAlone.ts', source)
  const rule = noDecisionsByOmission()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces no candidates for a value cast with as-unknown-as and a runtime check', t => {
  const source = `
    export const parseOrder = (raw) => {
      const body = JSON.parse(raw) as unknown
      if (!isOrder(body)) throw new Error('invalid order')
      return body
    }
  `
  const document = parser.parse('src/services/orderParser.ts', source)
  const rule = noDecisionsByOmission()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces one candidate for a non-null assertion after a map lookup', t => {
  const source = `
    export const profileOf = (id, cache) => {
      const user = cache.get(id)!.profile
      return user
    }
  `
  const document = parser.parse('src/services/profiles.ts', source)
  const rule = noDecisionsByOmission()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { escapes: { kind: string; source: string }[] }
  t.deepEqual(state.escapes, [{ kind: 'type', source: 'const user = cache.get(id)!.profile' }])
})

test('reports one escape even when the line scan and the comment scan both see it', t => {
  const source = `
    export const notify = (user) => {
      // @ts-ignore
      user.send()
    }
  `
  const document = parser.parse('src/services/notifier.ts', source)
  const rule = noDecisionsByOmission()

  const candidates = rule.collect(document)

  const state = candidates[0].state as { escapes: unknown[] }
  t.is(state.escapes.length, 1)
})

test('positions the single candidate on the function that leaves a decision unmade', t => {
  const source = `
    export const describe = (name) => {
      return 'hello ' + name
    }

    export const totalOf = (order) => {
      const total = (order as any).grandTotal
      return total
    }
  `
  const document = parser.parse('src/services/mixed.ts', source)
  const rule = noDecisionsByOmission()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as FunctionTarget).name, 'totalOf')
})

test('diagnose returns a warning at probability 0.90 with confidence 0.8', t => {
  const rule = noDecisionsByOmission()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('decision_left_by_omission', 0.90, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'warning')
})

test('diagnose returns an error at probability 0.96 with confidence 0.8', t => {
  const rule = noDecisionsByOmission()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('decision_left_by_omission', 0.96, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'error')
})

test('diagnose returns null below the warning threshold at probability 0.84', t => {
  const rule = noDecisionsByOmission()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('decision_left_by_omission', 0.84, 0.8), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null below minimum confidence at confidence 0.6', t => {
  const rule = noDecisionsByOmission()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('decision_left_by_omission', 0.96, 0.6), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the deliberate_with_stated_reason label', t => {
  const rule = noDecisionsByOmission()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('deliberate_with_stated_reason', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the boundary_type_narrowing label', t => {
  const rule = noDecisionsByOmission()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('boundary_type_narrowing', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('offers the model exactly four labels', t => {
  const candidate = fixtureCandidate()

  const labels = candidate.question.type === 'choice' ? Object.keys(candidate.question.criteria).sort() : []

  t.deepEqual(labels, [
    'boundary_type_narrowing',
    'decision_left_by_omission',
    'deliberate_with_stated_reason',
    'insufficient_context'
  ])
})

test('registers no-decisions-by-omission through the ideology plugin with a description', t => {
  const plugin = ideology()

  const rule = plugin.rules['no-decisions-by-omission']()

  t.is(typeof rule.description, 'string')
  t.true(rule.description.length > 0)
})
