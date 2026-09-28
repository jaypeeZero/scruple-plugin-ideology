import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import type { ChoiceAnswer, FunctionTarget, RuleCandidate } from '@scruple/core'
import { noHardcodedConfig } from '../src/rules/noHardcodedConfig.ts'
import { ideology } from '../src/index.ts'

const parser = oxcParser()

const fixtureCandidate = (): RuleCandidate => {
  const document = parser.parse('src/services/billing.ts', `
    export const charge = () => {
      const apiKey = 'sk-live-51H8xJ2eZvKYlo2C'
      return apiKey
    }
  `)
  const rule = noHardcodedConfig()
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

test('produces no candidates for a test file even with a hardcoded credential', t => {
  const source = `
    export const charge = () => {
      const apiKey = 'sk-live-51H8xJ2eZvKYlo2C'
      return apiKey
    }
  `
  const document = parser.parse('src/services/billing.spec.ts', source)
  const rule = noHardcodedConfig()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces no candidates for a composition-root document even with a hardcoded connection string', t => {
  const source = `
    export const openDb = () => {
      return connect('postgres://app:pw@db.internal:5432/app')
    }
  `
  const document = parser.parse('src/index.ts', source)
  const rule = noHardcodedConfig()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces one candidate for a function assigning an API key literal, with the line in literals', t => {
  const source = `
    export const charge = () => {
      const apiKey = 'sk-live-51H8xJ2eZvKYlo2C'
      return apiKey
    }
  `
  const document = parser.parse('src/services/billing.ts', source)
  const rule = noHardcodedConfig()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { literals: string[]; envReads: string[] }
  t.true(state.literals.some(line => line.includes('apiKey = \'sk-live-51H8xJ2eZvKYlo2C\'')))
  t.deepEqual(state.envReads, [])
})

test('produces one candidate for a function opening a connection string with a host and credentials', t => {
  const source = `
    export const openDb = () => {
      return connect('postgres://app:pw@db.internal:5432/app')
    }
  `
  const document = parser.parse('src/services/db.ts', source)
  const rule = noHardcodedConfig()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { literals: string[] }
  t.true(state.literals.some(line => line.includes('postgres://app:pw@db.internal:5432/app')))
})

test('produces one candidate for a function fetching a deploy-specific base URL', t => {
  const source = `
    export const createCharge = () => {
      return fetch('https://api.payments.example.com/v2/charges')
    }
  `
  const document = parser.parse('src/services/charges.ts', source)
  const rule = noHardcodedConfig()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { literals: string[] }
  t.true(state.literals.some(line => line.includes('api.payments.example.com')))
})

test('produces one candidate for a function reading process.env, with the line in envReads', t => {
  const source = `
    export const pricingFor = (item) => {
      const region = process.env.AWS_REGION
      return { item, region }
    }
  `
  const document = parser.parse('src/services/pricing.ts', source)
  const rule = noHardcodedConfig()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { literals: string[]; envReads: string[] }
  t.deepEqual(state.literals, [])
  t.true(state.envReads.some(line => line.includes('process.env.AWS_REGION')))
})

test('produces one candidate for a function assigning a bucket name by its object key', t => {
  const source = `
    export const storeInvoice = (invoice) => {
      s3.putObject({ Bucket: 'prod-invoices' })
      return invoice
    }
  `
  const document = parser.parse('src/services/invoices.ts', source)
  const rule = noHardcodedConfig()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { literals: string[] }
  t.true(state.literals.some(line => line.includes('Bucket: \'prod-invoices\'')))
})

test('produces no candidates for a fixed media-type literal assigned to an unrelated identifier', t => {
  const source = `
    export const toResponse = (body) => {
      const headers = {}
      headers['content-type'] = 'application/json'
      return { headers, body }
    }
  `
  const document = parser.parse('src/services/response.ts', source)
  const rule = noHardcodedConfig()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces one candidate for a fixed XML namespace, since its scheme prefix trips the default literal patterns', t => {
  const source = `
    export const svgRoot = () => {
      return { xmlns: 'http://www.w3.org/2000/svg' }
    }
  `
  const document = parser.parse('src/services/svg.ts', source)
  const rule = noHardcodedConfig()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
})

test('produces no candidates for a relative path with no matching literal or config name', t => {
  const source = `
    export const renderInvoice = (invoice) => {
      return readFile('./templates/invoice.html')
    }
  `
  const document = parser.parse('src/services/invoiceRenderer.ts', source)
  const rule = noHardcodedConfig()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces no candidates for a documented default option whose name is not a config name', t => {
  const source = `
    export const httpGet = (url, options) => {
      const timeoutMs = options.timeoutMs ?? 5000
      return fetch(url, { timeoutMs })
    }
  `
  const document = parser.parse('src/services/http.ts', source)
  const rule = noHardcodedConfig()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces one candidate for a localhost default, since it trips the default literal patterns', t => {
  const source = `
    export const connectRedis = (options) => {
      const host = options.host ?? 'localhost'
      return connect(host)
    }
  `
  const document = parser.parse('src/services/redis.ts', source)
  const rule = noHardcodedConfig()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { literals: string[] }
  t.true(state.literals.some(line => line.includes('\'localhost\'')))
})

test('positions the single candidate on the function that hardcodes the value', t => {
  const source = `
    export const describe = (name) => {
      return 'hello ' + name
    }

    export const openDb = () => {
      return connect('postgres://app:pw@db.internal:5432/app')
    }
  `
  const document = parser.parse('src/services/mixed.ts', source)
  const rule = noHardcodedConfig()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as FunctionTarget).name, 'openDb')
})

test('a custom compositionRootPattern changes which files are skipped', t => {
  const source = `
    export const openDb = () => {
      return connect('postgres://app:pw@db.internal:5432/app')
    }
  `
  const document = parser.parse('src/bootstrap/wireUp.ts', source)
  const defaultRule = noHardcodedConfig()
  const customRule = noHardcodedConfig({ compositionRootPattern: '(^|/)wireUp\\.[cm]?[jt]sx?$' })

  t.is(defaultRule.collect(document).length, 1)
  t.deepEqual(customRule.collect(document), [])
})

test('a custom configLiteralPatterns changes which literals are recognized as hardcoded config', t => {
  const source = `
    export const openDb = () => {
      return connect('company-internal-db-primary')
    }
  `
  const document = parser.parse('src/services/db.ts', source)
  const defaultRule = noHardcodedConfig()
  const customRule = noHardcodedConfig({ configLiteralPatterns: ['^company-internal-'] })

  t.deepEqual(defaultRule.collect(document), [])
  t.is(customRule.collect(document).length, 1)
})

test('diagnose returns a warning at probability 0.90 with confidence 0.8', t => {
  const rule = noHardcodedConfig()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('hardcodes_deploy_specific_value', 0.90, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'warning')
})

test('diagnose returns an error at probability 0.96 with confidence 0.8', t => {
  const rule = noHardcodedConfig()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('hardcodes_deploy_specific_value', 0.96, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'error')
})

test('diagnose returns null below the warning threshold at probability 0.84', t => {
  const rule = noHardcodedConfig()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('hardcodes_deploy_specific_value', 0.84, 0.8), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null below minimum confidence at confidence 0.6', t => {
  const rule = noHardcodedConfig()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('hardcodes_deploy_specific_value', 0.96, 0.6), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the fixed_protocol_constant label', t => {
  const rule = noHardcodedConfig()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('fixed_protocol_constant', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the declared_default_for_injected_option label', t => {
  const rule = noHardcodedConfig()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('declared_default_for_injected_option', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('offers the model exactly four labels', t => {
  const candidate = fixtureCandidate()

  const labels = candidate.question.type === 'choice' ? Object.keys(candidate.question.criteria).sort() : []

  t.deepEqual(labels, [
    'declared_default_for_injected_option',
    'fixed_protocol_constant',
    'hardcodes_deploy_specific_value',
    'insufficient_context'
  ])
})

test('registers no-hardcoded-config through the ideology plugin with a description', t => {
  const plugin = ideology()

  const rule = plugin.rules['no-hardcoded-config']()

  t.is(typeof rule.description, 'string')
  t.true(rule.description.length > 0)
})
