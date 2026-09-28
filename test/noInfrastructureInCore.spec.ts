import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import type { ChoiceAnswer, FunctionTarget, RuleCandidate } from '@scruple/core'
import { noInfrastructureInCore } from '../src/rules/noInfrastructureInCore.ts'
import { ideology } from '../src/index.ts'

const parser = oxcParser()

const pricingSource = `
  import { Pool } from 'pg'

  export const priceFor = async (sku: string, pool: Pool): Promise<number> => {
    const result = await pool.query('select base_price, quantity from prices where sku = $1', [sku])
    const basePrice = result.rows[0].base_price
    const quantity = result.rows[0].quantity
    if (quantity >= 100) {
      return basePrice * 0.8
    }
    if (quantity >= 10) {
      return basePrice * 0.9
    }
    return basePrice
  }
`

const fixtureCandidate = (): RuleCandidate => {
  const document = parser.parse('src/services/pricing.ts', pricingSource)
  const rule = noInfrastructureInCore()
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

test('produces no candidates for a file with no infrastructure import, regardless of branching or arithmetic', t => {
  const source = `
    export const priceFor = (basePrice: number, quantity: number): number => {
      if (quantity >= 100) {
        return basePrice * 0.8
      }
      return basePrice
    }
  `
  const document = parser.parse('src/services/purePricing.ts', source)
  const rule = noInfrastructureInCore()

  t.deepEqual(rule.collect(document), [])
})

test('produces no candidates for a function in an importing file that never references the binding', t => {
  const source = `
    import { Pool } from 'pg'

    export const describe = (name: string): string => {
      return \`hello \${name}\`
    }
  `
  const document = parser.parse('src/services/greeter.ts', source)
  const rule = noInfrastructureInCore()

  t.deepEqual(rule.collect(document), [])
})

test('produces no candidates for a composition root even with an infrastructure import and rule signals', t => {
  const document = parser.parse('src/index.ts', pricingSource)
  const rule = noInfrastructureInCore()

  t.deepEqual(rule.collect(document), [])
})

test('produces no candidates for a test file even with an infrastructure import and rule signals', t => {
  const document = parser.parse('src/services/pricing.spec.ts', pricingSource)
  const rule = noInfrastructureInCore()

  t.deepEqual(rule.collect(document), [])
})

test('produces one candidate naming the Pool binding for a function that queries then branches on the result', t => {
  const document = parser.parse('src/services/pricing.ts', pricingSource)
  const rule = noInfrastructureInCore()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { infrastructureBindings: string[] }
  t.deepEqual(state.infrastructureBindings, ['Pool'])
})

test('produces one candidate for a repository adapter whose only rule signal is a missing-row guard', t => {
  const source = `
    import { Pool } from 'pg'

    export const findUser = async (id: string, pool: Pool) => {
      const result = await pool.query('select id, name, email from users where id = $1', [id])
      const row = result.rows[0]
      if (!row) return null
      return { id: row.id, name: row.name, email: row.email }
    }
  `
  const document = parser.parse('src/services/userRepository.ts', source)
  const rule = noInfrastructureInCore()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { ruleSignals: string[] }
  t.deepEqual(state.ruleSignals, ['if (!row) return null'])
})

test('a custom infrastructureImportPatterns swaps which import counts', t => {
  const source = `
    import { connect } from 'my-orm'

    export const priceFor = async (sku: string, connection: unknown): Promise<number> => {
      const row = await connect(sku)
      const basePrice = row.basePrice
      const quantity = row.quantity
      if (quantity >= 10) {
        return basePrice * 0.9
      }
      return basePrice
    }
  `
  const document = parser.parse('src/services/ormPricing.ts', source)

  t.deepEqual(noInfrastructureInCore().collect(document), [])

  const candidates = noInfrastructureInCore({ infrastructureImportPatterns: ['^my-orm$'] }).collect(document)
  t.is(candidates.length, 1)
  const state = candidates[0].state as { infrastructureBindings: string[] }
  t.deepEqual(state.infrastructureBindings, ['connect'])
})

test('names the default import binding for a default import', t => {
  const source = `
    import Stripe from 'stripe'

    export const placeOrder = async (order: { items: { price: number; quantity: number }[] }, stripe: Stripe) => {
      const subtotal = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0)
      const freeShippingThreshold = 100
      const shippingFee = subtotal >= freeShippingThreshold ? 0 : 12
      const total = subtotal + shippingFee
      return stripe.charges.create({ amount: total * 100, currency: 'usd' })
    }
  `
  const document = parser.parse('src/services/orderFlow.ts', source)
  const rule = noInfrastructureInCore()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { infrastructureBindings: string[] }
  t.deepEqual(state.infrastructureBindings, ['Stripe'])
})

test('names the namespace import binding for a namespace import', t => {
  const source = `
    import * as express from 'express'

    export const deactivateUserHandler = async (
      req: express.Request,
      res: express.Response,
      service: { deactivate: (id: string) => Promise<boolean> }
    ) => {
      const deactivated = await service.deactivate(req.params.id)
      if (!deactivated) {
        return res.status(404).send()
      }
      return res.status(200).send()
    }
  `
  const document = parser.parse('src/services/userHandler.ts', source)
  const rule = noInfrastructureInCore()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { infrastructureBindings: string[] }
  t.deepEqual(state.infrastructureBindings, ['express'])
})

test('positions the single candidate on the function referencing the infrastructure binding', t => {
  const source = `
    import { Pool } from 'pg'

    export const describe = (name: string): string => {
      return \`hello \${name}\`
    }

    export const priceFor = async (sku: string, pool: Pool): Promise<number> => {
      const result = await pool.query('select base_price from prices where sku = $1', [sku])
      const basePrice = result.rows[0].base_price
      if (basePrice > 100) {
        return basePrice * 0.9
      }
      return basePrice
    }
  `
  const document = parser.parse('src/services/mixed.ts', source)
  const rule = noInfrastructureInCore()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as FunctionTarget).name, 'priceFor')
})

test('diagnose returns a warning at probability 0.90 with confidence 0.8', t => {
  const rule = noInfrastructureInCore()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('core_depends_on_infrastructure', 0.90, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'warning')
})

test('diagnose returns an error at probability 0.96 with confidence 0.8', t => {
  const rule = noInfrastructureInCore()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('core_depends_on_infrastructure', 0.96, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'error')
})

test('diagnose returns null below the warning threshold at probability 0.84', t => {
  const rule = noInfrastructureInCore()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('core_depends_on_infrastructure', 0.84, 0.8), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null below minimum confidence at confidence 0.6', t => {
  const rule = noInfrastructureInCore()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('core_depends_on_infrastructure', 0.96, 0.6), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the edge_adapter label', t => {
  const rule = noInfrastructureInCore()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('edge_adapter', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the infrastructure_type_only label', t => {
  const rule = noInfrastructureInCore()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('infrastructure_type_only', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for a wrong answer type', t => {
  const rule = noInfrastructureInCore()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose({ type: 'noul', noul: 0.99 }, candidate)

  t.is(diagnostic, null)
})

test('offers the model exactly four labels', t => {
  const candidate = fixtureCandidate()

  const labels = candidate.question.type === 'choice' ? Object.keys(candidate.question.criteria).sort() : []

  t.deepEqual(labels, [
    'core_depends_on_infrastructure',
    'edge_adapter',
    'infrastructure_type_only',
    'insufficient_context'
  ])
})

test('registers no-infrastructure-in-core through the ideology plugin with a description', t => {
  const plugin = ideology()

  const rule = plugin.rules['no-infrastructure-in-core']()

  t.is(typeof rule.description, 'string')
  t.true(rule.description.length > 0)
})
