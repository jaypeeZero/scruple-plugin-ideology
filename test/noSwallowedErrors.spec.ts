import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import type { ChoiceAnswer, ErrorHandlerTarget, RuleCandidate } from '@scruple/core'
import { noSwallowedErrors } from '../src/rules/noSwallowedErrors.ts'
import { ideology } from '../src/index.ts'

const parser = oxcParser()

const fixtureCandidate = (): RuleCandidate => {
  const document = parser.parse('src/services/persist.ts', `
    export const persist = async (x, save) => {
      try {
        await save(x)
      } catch {}
    }
  `)
  const rule = noSwallowedErrors()
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

test('produces no candidates for a test file even with a catch block present', t => {
  const source = `
    export const persist = async (x, save) => {
      try {
        await save(x)
      } catch {}
    }
  `
  const document = parser.parse('src/services/persist.spec.ts', source)
  const rule = noSwallowedErrors()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces one candidate for a function with a single catch block', t => {
  const source = `
    export const persist = async (x, save) => {
      try {
        await save(x)
      } catch (e) {
        console.error('save failed', e)
        throw e
      }
    }
  `
  const document = parser.parse('src/services/persist.ts', source)
  const rule = noSwallowedErrors()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as ErrorHandlerTarget).binding, 'e')
})

test('produces no candidates for a file with no catch blocks', t => {
  const source = `
    export const greet = (name) => {
      return 'hello ' + name
    }
  `
  const document = parser.parse('src/services/greeter.ts', source)
  const rule = noSwallowedErrors()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces no candidates for a bare try/finally with no catch clause', t => {
  const source = `
    export const withConn = async (fn, conn) => {
      try {
        return await fn(conn)
      } finally {
        await conn.close()
      }
    }
  `
  const document = parser.parse('src/services/withConn.ts', source)
  const rule = noSwallowedErrors()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces two candidates in source order for a file with two try/catch blocks', t => {
  const source = `
    export const getUser = async (id, repo) => {
      try {
        return await repo.find(id)
      } catch (e) {
        return null
      }
    }

    export const listOrders = async (repo) => {
      try {
        return await repo.all()
      } catch (e) {
        return []
      }
    }
  `
  const document = parser.parse('src/services/repoReads.ts', source)
  const rule = noSwallowedErrors()

  const candidates = rule.collect(document)

  t.is(candidates.length, 2)
  const first = candidates[0].target as ErrorHandlerTarget
  const second = candidates[1].target as ErrorHandlerTarget
  t.true(first.range.start < second.range.start)
})

test('sets isApiBoundary to true for a catch block inside an Express route handler', t => {
  const source = `
    import express from 'express'

    const app = express()

    app.post('/users/:id/deactivate', async (req, res) => {
      try {
        await deactivateUser(req.params.id)
        res.status(204).end()
      } catch (e) {
        res.status(500).json({ error: 'failed to deactivate' })
      }
    })
  `
  const document = parser.parse('src/routes/deactivate.ts', source)
  const rule = noSwallowedErrors()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { isApiBoundary: boolean }
  t.true(state.isApiBoundary)
})

test('sets isApiBoundary to false for a catch block outside any API boundary', t => {
  const source = `
    export const main = async () => {
      try {
        await run()
      } catch (e) {
        console.error(e)
        process.exitCode = 1
      }
    }
  `
  const document = parser.parse('src/main.ts', source)
  const rule = noSwallowedErrors()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { isApiBoundary: boolean }
  t.false(state.isApiBoundary)
})

test('carries the try block source, exits, and calls in state', t => {
  const source = `
    export const chargeCard = async (order, gateway) => {
      try {
        return await gateway.charge(order)
      } catch (e) {
        throw new PaymentDeclinedError(order.id, { cause: e })
      }
    }
  `
  const document = parser.parse('src/services/chargeCard.ts', source)
  const rule = noSwallowedErrors()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as {
    tried: { text: string }
    exits: Array<{ kind: string; source: string }>
    binding: string | null
  }
  t.true(state.tried.text.includes('gateway.charge(order)'))
  t.true(state.exits.some(exit => exit.kind === 'throw' && exit.source.includes('PaymentDeclinedError')))
  t.is(state.binding, 'e')
})

test('diagnose returns a warning at probability 0.90 with confidence 0.8', t => {
  const rule = noSwallowedErrors()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('swallows_or_masks_error', 0.90, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'warning')
})

test('diagnose returns an error at probability 0.96 with confidence 0.8', t => {
  const rule = noSwallowedErrors()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('swallows_or_masks_error', 0.96, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'error')
})

test('diagnose returns null below the warning threshold at probability 0.84', t => {
  const rule = noSwallowedErrors()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('swallows_or_masks_error', 0.84, 0.8), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null below minimum confidence at confidence 0.6', t => {
  const rule = noSwallowedErrors()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('swallows_or_masks_error', 0.96, 0.6), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the recovers_and_continues label', t => {
  const rule = noSwallowedErrors()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('recovers_and_continues', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the handles_at_entry_point label', t => {
  const rule = noSwallowedErrors()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('handles_at_entry_point', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the cleanup_only label', t => {
  const rule = noSwallowedErrors()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('cleanup_only', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for a wrong answer type', t => {
  const rule = noSwallowedErrors()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose({ type: 'noul', noul: 0.96 }, candidate)

  t.is(diagnostic, null)
})

test('offers the model exactly five labels', t => {
  const candidate = fixtureCandidate()

  const labels = candidate.question.type === 'choice' ? Object.keys(candidate.question.criteria).sort() : []

  t.deepEqual(labels, [
    'cleanup_only',
    'handles_at_entry_point',
    'insufficient_context',
    'recovers_and_continues',
    'swallows_or_masks_error'
  ])
})

test('registers no-swallowed-errors through the ideology plugin with a description', t => {
  const plugin = ideology()

  const rule = plugin.rules['no-swallowed-errors']()

  t.is(typeof rule.description, 'string')
  t.true(rule.description.length > 0)
})
