import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import type { ChoiceAnswer, FunctionTarget, RuleCandidate } from '@scruple/core'
import { noVendorTypesInCore } from '../src/rules/noVendorTypesInCore.ts'
import { ideology } from '../src/index.ts'

const parser = oxcParser()

const queryResultSource = `
  import { Pool, QueryResult } from 'pg'

  export const findUsers = async (pool: Pool): Promise<QueryResult> => {
    return pool.query('select id, name from users')
  }
`

const fixtureCandidate = (): RuleCandidate => {
  const document = parser.parse('src/services/userQueries.ts', queryResultSource)
  const rule = noVendorTypesInCore()
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

test('produces no candidates for a file whose imports match no infrastructure pattern', t => {
  const source = `
    import { z } from 'zod'

    const OrderSchema = z.object({ id: z.string() })

    export const parseOrder = (raw: unknown): z.infer<typeof OrderSchema> => {
      return OrderSchema.parse(raw)
    }
  `
  const document = parser.parse('src/services/orderParser.ts', source)

  t.deepEqual(noVendorTypesInCore().collect(document), [])
})

test('produces no candidates for a composition root even with a vendor return type', t => {
  const document = parser.parse('src/index.ts', queryResultSource)

  t.deepEqual(noVendorTypesInCore().collect(document), [])
})

test('produces no candidates for a test file even with a vendor return type', t => {
  const document = parser.parse('src/services/userQueries.spec.ts', queryResultSource)

  t.deepEqual(noVendorTypesInCore().collect(document), [])
})

test('produces one candidate with the return type and the returned call as leaks when a vendor result is returned unmapped', t => {
  const document = parser.parse('src/services/userQueries.ts', queryResultSource)

  const candidates = noVendorTypesInCore().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { signatureLeaks: string[]; returnLeaks: string[] }
  t.deepEqual(state.signatureLeaks, ['Promise<QueryResult>'])
  t.deepEqual(state.returnLeaks, ['return pool.query(\'select id, name from users\')'])
})

test('produces one candidate with a return leak when an injected vendor client\'s response is returned directly', t => {
  const source = `
    import Stripe from 'stripe'

    export const chargeCard = async (stripe: Stripe, cents: number) => {
      return stripe.charges.create({ amount: cents, currency: 'usd' })
    }
  `
  const document = parser.parse('src/services/payments.ts', source)

  const candidates = noVendorTypesInCore().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { signatureLeaks: string[]; returnLeaks: string[] }
  t.deepEqual(state.signatureLeaks, [])
  t.is(state.returnLeaks.length, 1)
  t.true(state.returnLeaks[0].startsWith('return stripe.charges.create('))
})

test('produces one candidate with a signature leak when a vendor response type is a parameter that is only read', t => {
  const source = `
    import { AxiosResponse } from 'axios'

    export const handleWeather = (res: AxiosResponse): string => {
      const temperature = res.data.temperature
      return temperature > 30 ? 'hot' : 'mild'
    }
  `
  const document = parser.parse('src/services/weather.ts', source)

  const candidates = noVendorTypesInCore().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { signatureLeaks: string[]; returnLeaks: string[] }
  t.deepEqual(state.signatureLeaks, ['res: AxiosResponse'])
  t.deepEqual(state.returnLeaks, [])
})

test('produces one candidate with a return leak when an awaited vendor call is returned', t => {
  const source = `
    import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3'

    export const loadInvoice = async (client: S3Client, key: string) => {
      return await client.send(new GetObjectCommand({ Bucket: 'invoices', Key: key }))
    }
  `
  const document = parser.parse('src/services/invoiceStore.ts', source)

  const candidates = noVendorTypesInCore().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { signatureLeaks: string[]; returnLeaks: string[] }
  t.is(state.returnLeaks.length, 1)
})

test('produces no candidates for an adapter that invokes its injected vendor client and returns a domain value', t => {
  const source = `
    import { Pool } from 'pg'

    interface User {
      id: string
      name: string
    }

    export const findUser = async (pool: Pool, id: string): Promise<User | null> => {
      const result = await pool.query('select id, name from users where id = $1', [id])
      const row = result.rows[0]
      if (!row) return null
      return { id: row.id, name: row.name }
    }
  `
  const document = parser.parse('src/services/userRepository.ts', source)

  t.deepEqual(noVendorTypesInCore().collect(document), [])
})

test('produces no candidates when the vendor call result is mapped before being returned', t => {
  const source = `
    import { Pool } from 'pg'

    const mapRow = (row: { id: string; name: string }) => ({ id: row.id, name: row.name })

    export const findFirst = async (pool: Pool) => {
      const r = await pool.query('select id, name from users limit 1')
      return mapRow(r.rows[0])
    }
  `
  const document = parser.parse('src/services/firstUser.ts', source)

  t.deepEqual(noVendorTypesInCore().collect(document), [])
})

test('produces no candidates when a namespace import is used only inside the body', t => {
  const source = `
    import * as pg from 'pg'

    interface UserRepository {
      findById: (id: string) => Promise<{ id: string; name: string } | null>
    }

    export const openPool = (url: string): UserRepository => {
      const pool = new pg.Pool({ connectionString: url })
      return {
        findById: async (id) => {
          const result = await pool.query('select id, name from users where id = $1', [id])
          const row = result.rows[0]
          return row ? { id: row.id, name: row.name } : null
        }
      }
    }
  `
  const document = parser.parse('src/services/userRepositoryFactory.ts', source)

  t.deepEqual(noVendorTypesInCore().collect(document), [])
})

test('treats a namespace-qualified vendor type in the return annotation as a signature leak', t => {
  const source = `
    import * as pg from 'pg'

    export const openPool = (url: string): pg.Pool => {
      return new pg.Pool({ connectionString: url })
    }
  `
  const document = parser.parse('src/services/poolFactory.ts', source)

  const candidates = noVendorTypesInCore().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { signatureLeaks: string[]; returnLeaks: string[] }
  t.deepEqual(state.signatureLeaks, ['pg.Pool'])
  t.deepEqual(state.returnLeaks, ['return new pg.Pool({ connectionString: url })'])
})

test('produces one candidate for an edge helper that accepts a framework request type', t => {
  const source = `
    import { Request } from 'express'

    export const userIdFrom = (req: Request): string => {
      return req.params.id
    }
  `
  const document = parser.parse('src/http/requestHelpers.ts', source)

  const candidates = noVendorTypesInCore().collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { signatureLeaks: string[]; returnLeaks: string[] }
  t.deepEqual(state.signatureLeaks, ['req: Request'])
})

test('a custom infrastructureImportPatterns swaps which import counts', t => {
  const source = `
    import { Row } from 'my-orm'

    export const firstRow = (rows: Row[]): Row => {
      return rows[0]
    }
  `
  const document = parser.parse('src/services/rows.ts', source)

  t.deepEqual(noVendorTypesInCore().collect(document), [])

  const candidates = noVendorTypesInCore({ infrastructureImportPatterns: ['^my-orm$'] }).collect(document)
  t.is(candidates.length, 1)
  const state = candidates[0].state as { signatureLeaks: string[]; returnLeaks: string[] }
  t.deepEqual(state.signatureLeaks, ['rows: Row[]', 'Row'])
})

test('positions the single candidate on the function whose signature leaks', t => {
  const source = `
    import { Pool, QueryResult } from 'pg'

    export const describe = (name: string): string => {
      return \`hello \${name}\`
    }

    export const findUsers = async (pool: Pool): Promise<QueryResult> => {
      return pool.query('select id, name from users')
    }
  `
  const document = parser.parse('src/services/mixed.ts', source)

  const candidates = noVendorTypesInCore().collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as FunctionTarget).name, 'findUsers')
})

test('diagnose returns a warning at probability 0.90 with confidence 0.8', t => {
  const rule = noVendorTypesInCore()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('vendor_shape_leaks_to_callers', 0.90, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'warning')
})

test('diagnose returns an error at probability 0.96 with confidence 0.8', t => {
  const rule = noVendorTypesInCore()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('vendor_shape_leaks_to_callers', 0.96, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'error')
})

test('diagnose returns null below the warning threshold at probability 0.84', t => {
  const rule = noVendorTypesInCore()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('vendor_shape_leaks_to_callers', 0.84, 0.8), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null below minimum confidence at confidence 0.6', t => {
  const rule = noVendorTypesInCore()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('vendor_shape_leaks_to_callers', 0.96, 0.6), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the adapter_owns_the_vendor label', t => {
  const rule = noVendorTypesInCore()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('adapter_owns_the_vendor', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the vendor_type_is_the_domain label', t => {
  const rule = noVendorTypesInCore()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('vendor_type_is_the_domain', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for a wrong answer type', t => {
  const rule = noVendorTypesInCore()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose({ type: 'noul', noul: 0.99 }, candidate)

  t.is(diagnostic, null)
})

test('offers the model exactly four labels', t => {
  const candidate = fixtureCandidate()

  const labels = candidate.question.type === 'choice' ? Object.keys(candidate.question.criteria).sort() : []

  t.deepEqual(labels, [
    'adapter_owns_the_vendor',
    'insufficient_context',
    'vendor_shape_leaks_to_callers',
    'vendor_type_is_the_domain'
  ])
})

test('registers no-vendor-types-in-core through the ideology plugin with a description', t => {
  const plugin = ideology()

  const rule = plugin.rules['no-vendor-types-in-core']()

  t.is(typeof rule.description, 'string')
  t.true(rule.description.length > 0)
})
