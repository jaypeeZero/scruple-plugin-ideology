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

test('produces no candidates for a query through an injected pool, whose policy belongs where the pool is built', t => {
  const source = `
    import { Pool } from 'pg'

    export const listOrders = async (pool: Pool) => {
      const rows = await pool.query('select * from orders')
      return rows
    }
  `
  const document = parser.parse('src/services/orders.ts', source)

  t.deepEqual(outboundCallResilience().collect(document), [])
})

test('produces no candidates for a vendor SDK call through an injected client', t => {
  const source = `
    import Stripe from 'stripe'

    export const charge = async (stripe: Stripe, cents: number) => {
      return await stripe.charges.create({ amount: cents, currency: 'usd' })
    }
  `
  const document = parser.parse('src/services/payments.ts', source)

  t.deepEqual(outboundCallResilience().collect(document), [])
})

test('produces no candidates for a repository query through an ORM table it was given', t => {
  const source = `
    import type { ModelStatic } from 'sequelize'

    export class PostgresOrderRepository {
      readonly #table: ModelStatic<OrderRow>

      constructor (table: ModelStatic<OrderRow>) {
        this.#table = table
      }

      async findById (id: string) {
        const row = await this.#table.findByPk(id)
        return row === null ? null : { id: row.id }
      }
    }
  `
  const document = parser.parse('src/repositories/orderRepository.ts', source)

  t.deepEqual(outboundCallResilience().collect(document), [])
})

test('produces one candidate for an awaited axios call made on the default instance, with no client built for it', t => {
  const source = `
    import axios from 'axios'

    export const loadRates = async (url: string) => {
      const response = await axios.get(url)
      return response.data
    }
  `
  const document = parser.parse('src/services/ratesAxios.ts', source)

  const candidates = outboundCallResilience().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { outboundCalls: { callee: string }[] }
  t.is(state.outboundCalls[0].callee, 'axios.get')
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
    export const loadRates = async (url: string) => {
      return retry(async () => await fetch(url), { retries: 3 })
    }
  `
  const document = parser.parse('src/services/ratesRetryWrapper.ts', source)

  const candidates = outboundCallResilience().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { outboundCalls: { callee: string }[]; resilience: string[] }
  t.is(state.outboundCalls[0].callee, 'fetch')
  t.true(state.resilience.length > 0)
})

test('produces one candidate with the race as resilience when an outbound call is nested inside an awaited Promise.race', t => {
  const source = `
    export const loadRates = async (url: string) => {
      return await Promise.race([fetch(url), rejectAfter(3000)])
    }
  `
  const document = parser.parse('src/services/ratesPromiseRace.ts', source)

  const candidates = outboundCallResilience().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { outboundCalls: { callee: string }[]; resilience: string[] }
  t.deepEqual(state.outboundCalls.map(call => call.callee), ['fetch'])
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
    import axios from 'axios'

    export const syncAll = async (url: string) => {
      await fetch(url + '/one')
      await fetch(url + '/two')
      await axios.post(url, {})
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

test('produces one candidate listing the construction when composition code builds an axios client', t => {
  const source = `
    import axios from 'axios'

    export const buildClients = (config: RatesConfig) => {
      const http = axios.create({ baseURL: config.baseUrl })
      return { rates: new HttpRatesClient(http) }
    }
  `
  const document = parser.parse('src/app/composition/clients.ts', source)

  const candidates = outboundCallResilience().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { clientConstructions: string[]; outboundCalls: unknown[] }
  t.deepEqual(state.clientConstructions, ['axios.create({ baseURL: config.baseUrl })'])
  t.deepEqual(state.outboundCalls, [])
})

test('produces one candidate when a function builds a pg pool', t => {
  const source = `
    import { Pool } from 'pg'

    export const createPool = (url: string): Pool => new Pool({ connectionString: url })
  `
  const document = parser.parse('src/app/conf/createPool.ts', source)

  const candidates = outboundCallResilience().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { clientConstructions: string[] }
  t.deepEqual(state.clientConstructions, ['new Pool({ connectionString: url })'])
})

test('produces one candidate with the statement timeout as resilience when a function builds a connection from a class it was given', t => {
  const source = `
    export const connect = async (url: string, SequelizeClass: new (url: string, options: object) => Db) => {
      const db = new SequelizeClass(url, { dialectOptions: { statement_timeout: 30000 }, pool: { acquire: 30000 } })
      await db.authenticate()
      return db
    }
  `
  const document = parser.parse('src/app/conf/connect.ts', source)

  const candidates = outboundCallResilience().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { clientConstructions: string[]; resilience: string[] }
  t.is(state.clientConstructions.length, 1)
  t.true(state.clientConstructions[0].startsWith('new SequelizeClass('))
  t.is(state.resilience.length, 1)
})

test('produces no candidates for constructing this codebase\'s own classes and plain values', t => {
  const source = `
    import { HttpRatesClient } from './ratesClient.js'

    export const buildRates = (http: Http) => {
      const createdAt = new Date()
      return { rates: new HttpRatesClient(http), createdAt }
    }
  `
  const document = parser.parse('src/app/composition/rates.ts', source)

  t.deepEqual(outboundCallResilience().collect(document), [])
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
