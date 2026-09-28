import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import type { ChoiceAnswer, FunctionTarget, RuleCandidate } from '@scruple/core'
import { noArgumentMutation } from '../src/rules/noArgumentMutation.ts'
import { ideology } from '../src/index.ts'

const parser = oxcParser()

const fixtureCandidate = (): RuleCandidate => {
  const document = parser.parse('src/services/orderDiscount.ts', `
    export const applyDiscount = (order) => {
      order.total = order.total * 0.9
      return order
    }
  `)
  const rule = noArgumentMutation()
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

test('produces no candidates for a test file even with a mutated parameter', t => {
  const source = `
    export const applyDiscount = (order) => {
      order.total = order.total * 0.9
      return order
    }
  `
  const document = parser.parse('src/services/orderDiscount.spec.ts', source)
  const rule = noArgumentMutation()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces one candidate for a function assigning to a property of a parameter', t => {
  const source = `
    export const applyDiscount = (order) => {
      order.total = order.total * 0.9
      return order
    }
  `
  const document = parser.parse('src/services/orderDiscount.ts', source)
  const rule = noArgumentMutation()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { mutations: string[] }
  t.true(state.mutations.some(line => line.includes('order.total =')))
})

test('produces one candidate for a function pushing into an array parameter', t => {
  const source = `
    export const addLineItem = (items, item) => {
      items.push(item)
      return items
    }
  `
  const document = parser.parse('src/services/lineItems.ts', source)
  const rule = noArgumentMutation()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { mutations: string[] }
  t.true(state.mutations.some(line => line.includes('items.push(item)')))
})

test('produces one candidate for a function assigning through a nested property path', t => {
  const source = `
    export const markShipped = (order) => {
      order.status.shipped = true
      return order
    }
  `
  const document = parser.parse('src/services/shipping.ts', source)
  const rule = noArgumentMutation()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { mutations: string[] }
  t.true(state.mutations.some(line => line.includes('order.status.shipped = true')))
})

test('produces one candidate for a function calling a mutating method on a Map parameter', t => {
  const source = `
    export const recordVisit = (counts, key) => {
      counts.set(key, (counts.get(key) ?? 0) + 1)
      return counts
    }
  `
  const document = parser.parse('src/services/visitCounts.ts', source)
  const rule = noArgumentMutation()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { mutations: string[] }
  t.true(state.mutations.some(line => line.includes('counts.set(')))
  t.false(state.mutations.some(line => line.includes('counts.get(') && !line.includes('counts.set(')))
})

test('produces one candidate for a function deleting a property of a parameter', t => {
  const source = `
    export const stripSecrets = (user) => {
      delete user.password
      return user
    }
  `
  const document = parser.parse('src/services/userSecrets.ts', source)
  const rule = noArgumentMutation()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { mutations: string[] }
  t.true(state.mutations.some(line => line.includes('delete user.password')))
})

test('produces one candidate for a function sorting an array parameter in place', t => {
  const source = `
    export const sortByDate = (events) => {
      events.sort((a, b) => a.date - b.date)
      return events
    }
  `
  const document = parser.parse('src/services/eventSchedule.ts', source)
  const rule = noArgumentMutation()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { mutations: string[] }
  t.true(state.mutations.some(line => line.includes('events.sort(')))
})

test('produces no candidates for a function that spreads a parameter into a new object', t => {
  const source = `
    export const applyDiscount = (order) => {
      return { ...order, total: order.total * 0.9 }
    }
  `
  const document = parser.parse('src/services/orderDiscountCopy.ts', source)
  const rule = noArgumentMutation()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces no candidates for a function that slices a parameter before sorting the copy', t => {
  const source = `
    export const sortByDate = (events) => {
      const copy = events.slice()
      copy.sort((a, b) => a.date - b.date)
      return copy
    }
  `
  const document = parser.parse('src/services/eventScheduleCopy.ts', source)
  const rule = noArgumentMutation()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces no candidates for a function building a local accumulator instead of mutating its parameters', t => {
  const source = `
    export const groupBy = (items, keyOf) => {
      const groups = new Map()
      for (const item of items) {
        const key = keyOf(item)
        const bucket = groups.get(key) ?? []
        bucket.push(item)
        groups.set(key, bucket)
      }
      return groups
    }
  `
  const document = parser.parse('src/services/grouping.ts', source)
  const rule = noArgumentMutation()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces no candidates for reassigning the parameter binding itself, only its members', t => {
  const source = `
    export const replaceOrder = (order) => {
      order = { ...order, total: 0 }
      return order
    }
  `
  const document = parser.parse('src/services/orderReplace.ts', source)
  const rule = noArgumentMutation()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces one candidate for a builder parameter filled through a mutating call', t => {
  const source = `
    export const writeHeaders = (response, headers) => {
      response.headers.set('content-type', headers.contentType)
      return response
    }
  `
  const document = parser.parse('src/services/responseHeaders.ts', source)
  const rule = noArgumentMutation()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as FunctionTarget).name, 'writeHeaders')
})

test('diagnose returns a warning at probability 0.90 with confidence 0.8', t => {
  const rule = noArgumentMutation()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('mutates_parameter', 0.90, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'warning')
})

test('diagnose returns an error at probability 0.96 with confidence 0.8', t => {
  const rule = noArgumentMutation()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('mutates_parameter', 0.96, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'error')
})

test('diagnose returns null below the warning threshold at probability 0.84', t => {
  const rule = noArgumentMutation()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('mutates_parameter', 0.84, 0.8), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null below minimum confidence at confidence 0.6', t => {
  const rule = noArgumentMutation()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('mutates_parameter', 0.96, 0.6), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the mutates_local_copy label', t => {
  const rule = noArgumentMutation()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('mutates_local_copy', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the parameter_is_a_builder_by_contract label', t => {
  const rule = noArgumentMutation()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('parameter_is_a_builder_by_contract', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for a wrong answer type', t => {
  const rule = noArgumentMutation()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose({ type: 'noul', noul: 0.96 }, candidate)

  t.is(diagnostic, null)
})

test('offers the model exactly four labels', t => {
  const candidate = fixtureCandidate()

  const labels = candidate.question.type === 'choice' ? Object.keys(candidate.question.criteria).sort() : []

  t.deepEqual(labels, [
    'insufficient_context',
    'mutates_local_copy',
    'mutates_parameter',
    'parameter_is_a_builder_by_contract'
  ])
})

test('produces one candidate when a destructured object parameter\'s renamed binding is mutated', t => {
  const source = `
    export const markShipped = ({ order: current }, at) => {
      current.status = 'shipped'
      current.shippedAt = at
      return current
    }
  `
  const document = parser.parse('src/services/shipping.ts', source)
  const rule = noArgumentMutation()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { parameters: string[]; mutations: string[] }
  t.deepEqual(state.parameters, ['current', 'at'])
  t.true(state.mutations.some(line => line.includes('current.status')))
})

test('produces one candidate when an array-destructured parameter element is pushed into', t => {
  const source = `
    export const appendTag = ([tags, meta], tag) => {
      tags.push(tag)
      return [tags, meta]
    }
  `
  const document = parser.parse('src/services/tags.ts', source)
  const rule = noArgumentMutation()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { parameters: string[] }
  t.deepEqual(state.parameters, ['tags', 'meta', 'tag'])
})

test('produces no candidates when a destructured parameter with a default is only read', t => {
  const source = `
    export const label = ({ name, count = 0 }, ...rest) => {
      return name + ':' + count + rest.length
    }
  `
  const document = parser.parse('src/services/label.ts', source)
  const rule = noArgumentMutation()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('registers no-argument-mutation through the ideology plugin with a description', t => {
  const plugin = ideology()

  const rule = plugin.rules['no-argument-mutation']()

  t.is(typeof rule.description, 'string')
  t.true(rule.description.length > 0)
})
