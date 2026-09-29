import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import type { ChoiceAnswer, RuleCandidate } from '@scruple/core'
import { outboundCallResilience } from '../src/rules/outboundCallResilience.ts'
import { ideology } from '../src/index.ts'

const parser = oxcParser()

const bareFetchSource = `
  export const loadRates = async (url: string) => {
    const res = await fetch(url)
    return res.json()
  }
`

const fixtureCandidate = (): RuleCandidate => {
  const document = parser.parse('src/services/rates.ts', bareFetchSource)
  const rule = outboundCallResilience()
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

test('produces one candidate with an empty callee and the fetch call listed when a bare fetch is awaited', t => {
  const document = parser.parse('src/services/rates.ts', bareFetchSource)

  const candidates = outboundCallResilience().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { outboundCalls: { callee: string; source: string; awaited: boolean }[]; resilience: string[] }
  t.is(state.outboundCalls.length, 1)
  t.is(state.outboundCalls[0].callee, 'fetch')
  t.true(state.outboundCalls[0].awaited)
  t.deepEqual(state.resilience, [])
})

test('produces one candidate with an empty resilience list when a database query is awaited without a guard', t => {
  const source = `
    import { Pool } from 'pg'

    export const listOrders = async (pool: Pool) => {
      const rows = await pool.query('select * from orders')
      return rows
    }
  `
  const document = parser.parse('src/services/orders.ts', source)

  const candidates = outboundCallResilience().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { outboundCalls: { callee: string }[]; resilience: string[] }
  t.is(state.outboundCalls[0].callee, 'pool.query')
  t.deepEqual(state.resilience, [])
})

test('produces one candidate when an awaited vendor SDK call has no guard', t => {
  const source = `
    import Stripe from 'stripe'

    export const charge = async (stripe: Stripe, cents: number) => {
      return await stripe.charges.create({ amount: cents, currency: 'usd' })
    }
  `
  const document = parser.parse('src/services/payments.ts', source)

  const candidates = outboundCallResilience().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { outboundCalls: { callee: string }[] }
  t.is(state.outboundCalls[0].callee, 'stripe.charges.create')
})

test('produces one candidate when an awaited queue publish has no guard', t => {
  const source = `
    export const emit = async (
      producer: { send: (message: unknown) => Promise<void> },
      event: unknown
    ) => {
      await producer.send({ topic: 'events', messages: [event] })
    }
  `
  const document = parser.parse('src/services/events.ts', source)

  const candidates = outboundCallResilience().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { outboundCalls: { callee: string }[] }
  t.is(state.outboundCalls[0].callee, 'producer.send')
})

test('produces one candidate with non-empty resilience when fetch carries an abort signal timeout', t => {
  const source = `
    export const loadRates = async (url: string) => {
      return await fetch(url, { signal: AbortSignal.timeout(5000) })
    }
  `
  const document = parser.parse('src/services/ratesAbortSignal.ts', source)

  const candidates = outboundCallResilience().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { outboundCalls: { callee: string }[]; resilience: string[] }
  t.is(state.outboundCalls[0].callee, 'fetch')
  t.true(state.resilience.length > 0)
})

test('produces one candidate with non-empty resilience when the awaited call sits inside a retry wrapper', t => {
  const source = `
    export const loadRates = async (
      client: { get: (url: string) => Promise<unknown> },
      url: string
    ) => {
      return retry(async () => await client.get(url), { retries: 3 })
    }
  `
  const document = parser.parse('src/services/ratesRetryWrapper.ts', source)

  const candidates = outboundCallResilience().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { outboundCalls: { callee: string }[]; resilience: string[] }
  t.is(state.outboundCalls[0].callee, 'client.get')
  t.true(state.resilience.length > 0)
})

test('produces one candidate with the race as resilience when an outbound call is nested inside an awaited Promise.race', t => {
  const source = `
    import { Pool } from 'pg'

    export const listOrders = async (pool: Pool) => {
      return await Promise.race([pool.query('select * from orders'), rejectAfter(3000)])
    }
  `
  const document = parser.parse('src/services/ordersPromiseRace.ts', source)

  const candidates = outboundCallResilience().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { outboundCalls: { callee: string }[]; resilience: string[] }
  t.deepEqual(state.outboundCalls.map(call => call.callee), ['pool.query'])
  t.is(state.resilience.length, 1)
  t.true(state.resilience[0].includes('Promise.race'))
})

test('produces one candidate with non-empty resilience when a fetch failure falls back to a cached value', t => {
  const source = `
    export const loadRates = async () => {
      try {
        // fallback to cached rates if the network call fails
        return await fetch('https://rates.example.com')
      } catch {
        return cachedRates
      }
    }
  `
  const document = parser.parse('src/services/ratesFallbackCached.ts', source)

  const candidates = outboundCallResilience().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { resilience: string[] }
  t.true(state.resilience.length > 0)
})

test('produces no candidates for pure computation with no calls', t => {
  const source = `
    export const double = (n: number): number => {
      return n * 2
    }
  `
  const document = parser.parse('src/services/pureMath.ts', source)

  t.deepEqual(outboundCallResilience().collect(document), [])
})

test('produces one candidate with signal text in resilience when an abort signal is passed through from the caller', t => {
  const source = `
    export const loadRates = async (url: string, signal: AbortSignal) => {
      return await fetch(url, { signal })
    }
  `
  const document = parser.parse('src/services/ratesSignalPassthrough.ts', source)

  const candidates = outboundCallResilience().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { outboundCalls: { callee: string }[]; resilience: string[] }
  t.is(state.outboundCalls[0].callee, 'fetch')
  t.true(state.resilience.length > 0)
})

test('produces no candidates for a test file even with an unguarded awaited fetch', t => {
  const document = parser.parse('src/services/rates.spec.ts', bareFetchSource)

  t.deepEqual(outboundCallResilience().collect(document), [])
})

test('collapses three unguarded outbound calls in one function into a single candidate listing all three', t => {
  const source = `
    export const syncAll = async (
      pool: { query: (sql: string) => Promise<unknown> },
      producer: { send: (message: unknown) => Promise<void> }
    ) => {
      await pool.query('one')
      await pool.query('two')
      await producer.send({ topic: 'x', messages: [] })
    }
  `
  const document = parser.parse('src/services/syncAll.ts', source)

  const candidates = outboundCallResilience().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { outboundCalls: { callee: string }[] }
  t.is(state.outboundCalls.length, 3)
})

test('a custom outboundCallPatterns option flags a callee the default patterns ignore', t => {
  const source = `
    export const notify = async (sdk: { doThing: () => Promise<void> }) => {
      await sdk.doThing()
    }
  `
  const document = parser.parse('src/services/notify.ts', source)

  t.deepEqual(outboundCallResilience().collect(document), [])

  const candidates = outboundCallResilience({ outboundCallPatterns: ['\\.doThing$'] }).collect(document)
  t.is(candidates.length, 1)
  const state = candidates[0].state as { outboundCalls: { callee: string }[] }
  t.is(state.outboundCalls[0].callee, 'sdk.doThing')
})

test('a custom resiliencePatterns option recognizes a guard word the default patterns ignore', t => {
  const source = `
    export const loadRates = async (url: string) => {
      // guardedManually elsewhere in the pipeline
      return await fetch(url)
    }
  `
  const document = parser.parse('src/services/ratesGuardedManually.ts', source)

  const defaultCandidates = outboundCallResilience().collect(document)
  t.is(defaultCandidates.length, 1)
  const defaultState = defaultCandidates[0].state as { resilience: string[] }
  t.deepEqual(defaultState.resilience, [])

  const customCandidates = outboundCallResilience({ resiliencePatterns: ['guardedManually'] }).collect(document)
  t.is(customCandidates.length, 1)
  const customState = customCandidates[0].state as { resilience: string[] }
  t.true(customState.resilience.length > 0)
})

test('an awaited call on an infrastructure import binding counts as outbound even without a pattern match', t => {
  const source = `
    import * as AWS from 'aws-sdk'

    export const notify = async () => {
      await AWS.customCall()
    }
  `
  const document = parser.parse('src/services/notifyAws.ts', source)

  const candidates = outboundCallResilience().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { outboundCalls: { callee: string }[] }
  t.is(state.outboundCalls[0].callee, 'AWS.customCall')
})

test('diagnose returns a warning at probability 0.90 with confidence 0.8', t => {
  const rule = outboundCallResilience()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('unguarded_outbound_call', 0.90, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'warning')
})

test('diagnose returns an error at probability 0.96 with confidence 0.8', t => {
  const rule = outboundCallResilience()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('unguarded_outbound_call', 0.96, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'error')
})

test('diagnose returns null below the warning threshold at probability 0.84', t => {
  const rule = outboundCallResilience()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('unguarded_outbound_call', 0.84, 0.8), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null below minimum confidence at confidence 0.6', t => {
  const rule = outboundCallResilience()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('unguarded_outbound_call', 0.96, 0.6), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the resilience_present label', t => {
  const rule = outboundCallResilience()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('resilience_present', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the resilience_owned_by_caller label', t => {
  const rule = outboundCallResilience()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('resilience_owned_by_caller', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for a wrong answer type', t => {
  const rule = outboundCallResilience()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose({ type: 'noul', noul: 0.99 }, candidate)

  t.is(diagnostic, null)
})

test('offers the model exactly four labels', t => {
  const candidate = fixtureCandidate()

  const labels = candidate.question.type === 'choice' ? Object.keys(candidate.question.criteria).sort() : []

  t.deepEqual(labels, [
    'insufficient_context',
    'resilience_owned_by_caller',
    'resilience_present',
    'unguarded_outbound_call'
  ])
})

test('registers outbound-call-resilience through the ideology plugin with a description', t => {
  const plugin = ideology()

  const rule = plugin.rules['outbound-call-resilience']()

  t.is(typeof rule.description, 'string')
  t.true(rule.description.length > 0)
})
