import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import type { ChoiceAnswer, FunctionTarget, RuleCandidate } from '@scruple/core'
import { oneJobPerFunction } from '../src/rules/oneJobPerFunction.ts'
import { ideology } from '../src/index.ts'

const parser = oxcParser()

const fixtureCandidate = (): RuleCandidate => {
  const document = parser.parse('src/services/registerUser.ts', `
    export const registerUser = (input, repo, logger) => {
      if (!input.isValidEmail()) {
        throw new Error('invalid email')
      }
      const user = repo.save(input)
      logger.info(\`registered user \${user.id}\`)
      return user
    }
  `)
  const rule = oneJobPerFunction()
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

test('produces no candidates for a test file even with two concerns present', t => {
  const source = `
    export const reportSales = (db) => {
      const rows = db.query('select * from sales')
      const total = rows.reduce((sum, row) => sum + row.amount, 0)
      const line = \`Total: \${total.toFixed(2)}\`
      return line
    }
  `
  const document = parser.parse('src/services/report.spec.ts', source)
  const rule = oneJobPerFunction()

  t.deepEqual(rule.collect(document), [])
})

// Prefilter arm (a): two or more distinct buckets among io/presentation/validation.
test('produces one candidate when io and presentation buckets are both hit', t => {
  const source = `
    export const reportSales = (db) => {
      const rows = db.query('select * from sales')
      const total = rows.reduce((sum, row) => sum + row.amount, 0)
      return \`Total: \${total.toFixed(2)}\`
    }
  `
  const document = parser.parse('src/services/report.ts', source)
  const rule = oneJobPerFunction()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { concerns: { bucket: string, callees: string[] }[] }
  const buckets = state.concerns.map(c => c.bucket).sort()
  t.deepEqual(buckets, ['io', 'presentation'])
})

// Prefilter arm (b): exactly one of io/presentation/validation hit, with branchCount >= 2.
test('produces one candidate when exactly one bucket is hit and branchCount is at least two', t => {
  const source = `
    export const priceFor = (sku) => {
      const response = fetch(\`https://api.example.test/prices/\${sku}\`)
      const price = response.amount
      if (price > 1000) {
        return price * 0.8
      }
      if (price > 500) {
        return price * 0.9
      }
      return price
    }
  `
  const document = parser.parse('src/services/priceFor.ts', source)
  const rule = oneJobPerFunction()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { concerns: { bucket: string }[], branchCount: number }
  t.deepEqual(state.concerns.map(c => c.bucket), ['io'])
  t.true(state.branchCount >= 2)
})

// A single bucket with branchCount below two must not trigger.
test('produces no candidates when exactly one bucket is hit and branchCount is below two', t => {
  const source = `
    export const findById = (id, db) => {
      const row = db.query(id)
      return { id: row.id, name: row.name }
    }
  `
  const document = parser.parse('src/services/findById.ts', source)
  const rule = oneJobPerFunction()

  t.deepEqual(rule.collect(document), [])
})

// Prefilter arm (c): non-blank line count exceeds minLines, independent of any bucket.
test('produces one candidate for a long function with no io, presentation, or validation calls', t => {
  const lines = Array.from({ length: 45 }, (_, i) => `  total = total + ${i}`).join('\n')
  const source = `
    export const processOrder = (order) => {
      let total = 0
${lines}
      return total
    }
  `
  const document = parser.parse('src/services/processOrder.ts', source)
  const rule = oneJobPerFunction()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { concerns: unknown[], lineCount: number }
  t.deepEqual(state.concerns, [])
  t.true(state.lineCount > 40)
})

// Orchestration alone must never trigger, and its branch count is deliberately non-zero.
test('produces no candidates when only orchestration calls on parameters are present', t => {
  const source = `
    export const deactivate = (userId, repo) => {
      const user = repo.locate(userId)
      if (user.isActive && user.role !== 'admin') {
        user.isActive = false
      }
      repo.commit(user)
      return user
    }
  `
  const document = parser.parse('src/services/deactivate.ts', source)
  const rule = oneJobPerFunction()

  t.deepEqual(rule.collect(document), [])
})

// The service pattern from the ideology docs: injected repository, two guards. Its
// repository calls match the io patterns, so the prefilter hands it to the model
// rather than deciding for itself that orchestration is the function's one job.
test('produces one candidate for a service that orchestrates an injected repository through io-named methods', t => {
  const source = `
    export const deactivate = (userId, repo) => {
      const user = repo.findById(userId)
      if (!user) throw new NotFoundError(userId)
      if (!user.isActive) return user
      const updated = { ...user, isActive: false }
      repo.save(updated)
      return updated
    }
  `
  const document = parser.parse('src/services/deactivate.ts', source)
  const rule = oneJobPerFunction()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { concerns: { bucket: string }[]; branchCount: number }
  t.deepEqual(state.concerns.map(concern => concern.bucket), ['io'])
  t.true(state.branchCount >= 2)
})

// branchCount alone, with zero io/presentation/validation buckets, must never trigger.
test('produces no candidates for a short function with several branches and no calls at all', t => {
  const source = `
    export const discountFor = (order) => {
      let discount = 0
      if (order.total > 1000) {
        discount = 0.2
      } else if (order.total > 500) {
        discount = 0.15
      } else if (order.total > 100) {
        discount = 0.1
      } else if (order.isFirstPurchase) {
        discount = 0.05
      }
      return order.total * (1 - discount)
    }
  `
  const document = parser.parse('src/services/discountFor.ts', source)
  const rule = oneJobPerFunction()

  t.deepEqual(rule.collect(document), [])
})

// The same short, callee-free, business-only function flips to a candidate once minLines is lowered.
test('a minLines option of 10 turns the short pure-business-rule function into a candidate', t => {
  const source = `
    export const discountFor = (order) => {
      let discount = 0
      if (order.total > 1000) {
        discount = 0.2
      } else if (order.total > 500) {
        discount = 0.15
      } else if (order.total > 100) {
        discount = 0.1
      } else if (order.isFirstPurchase) {
        discount = 0.05
      }
      const adjusted = order.total * (1 - discount)
      return adjusted
    }
  `
  const document = parser.parse('src/services/discountFor.ts', source)

  t.deepEqual(oneJobPerFunction().collect(document), [])

  const candidates = oneJobPerFunction({ minLines: 10 }).collect(document)
  t.is(candidates.length, 1)
})

test('reports presentation as hit from three or more template literals with no matching callee', t => {
  const source = `
    export const describeOrder = (order) => {
      const a = \`Order \${order.id}\`
      const b = \`Total \${order.total}\`
      const c = \`Status \${order.status}\`
      return db.query(a + b + c)
    }
  `
  const document = parser.parse('src/services/describeOrder.ts', source)
  const rule = oneJobPerFunction()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { concerns: { bucket: string, callees: string[] }[] }
  const presentation = state.concerns.find(c => c.bucket === 'presentation')
  t.truthy(presentation)
  t.deepEqual(presentation?.callees, [])
})

test('positions the single candidate on the function that mixes concerns', t => {
  const source = `
    export const describe = (name) => {
      return 'hello ' + name
    }

    export const reportSales = (db) => {
      const rows = db.query('select * from sales')
      const total = rows.reduce((sum, row) => sum + row.amount, 0)
      return \`Total: \${total.toFixed(2)}\`
    }
  `
  const document = parser.parse('src/services/mixed.ts', source)
  const rule = oneJobPerFunction()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as FunctionTarget).name, 'reportSales')
})

test('diagnose returns a warning at probability 0.90 with confidence 0.8', t => {
  const rule = oneJobPerFunction()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('mixes_concerns', 0.90, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'warning')
})

test('diagnose returns an error at probability 0.96 with confidence 0.8', t => {
  const rule = oneJobPerFunction()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('mixes_concerns', 0.96, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'error')
})

test('diagnose returns null below the warning threshold at probability 0.84', t => {
  const rule = oneJobPerFunction()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('mixes_concerns', 0.84, 0.8), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null below minimum confidence at confidence 0.6', t => {
  const rule = oneJobPerFunction()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('mixes_concerns', 0.96, 0.6), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the single_concern label', t => {
  const rule = oneJobPerFunction()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('single_concern', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the thin_entry_point label', t => {
  const rule = oneJobPerFunction()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('thin_entry_point', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('offers the model exactly four labels', t => {
  const candidate = fixtureCandidate()

  const labels = candidate.question.type === 'choice' ? Object.keys(candidate.question.criteria).sort() : []

  t.deepEqual(labels, [
    'insufficient_context',
    'mixes_concerns',
    'single_concern',
    'thin_entry_point'
  ])
})

test('registers one-job-per-function through the ideology plugin with a description', t => {
  const plugin = ideology()

  const rule = plugin.rules['one-job-per-function']()

  t.is(typeof rule.description, 'string')
  t.true(rule.description.length > 0)
})
