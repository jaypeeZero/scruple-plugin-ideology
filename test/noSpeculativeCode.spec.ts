import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import type { ChoiceAnswer, FunctionTarget, RuleCandidate } from '@scruple/core'
import { noSpeculativeCode } from '../src/rules/noSpeculativeCode.ts'
import { ideology } from '../src/index.ts'

const parser = oxcParser()

const fixtureCandidate = (): RuleCandidate => {
  const document = parser.parse('src/services/mail.ts', `
    export const sendEmail = (to, body, options: { cc?: string; bcc?: string; priority?: number }) => {
      return \`sending to \${to}: \${body}\`
    }
  `)
  const rule = noSpeculativeCode()
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

test('produces no candidates for a test file even with unread options', t => {
  const source = `
    export const sendEmail = (to, body, options: { cc?: string; bcc?: string; priority?: number }) => {
      return \`sending to \${to}: \${body}\`
    }
  `
  const document = parser.parse('src/services/mail.spec.ts', source)
  const rule = noSpeculativeCode()

  t.deepEqual(rule.collect(document), [])
})

test('produces one unread-options candidate when an inline options type has none of its keys read', t => {
  const source = `
    export const sendEmail = (to, body, options: { cc?: string; bcc?: string; priority?: number }) => {
      return \`sending to \${to}: \${body}\`
    }
  `
  const document = parser.parse('src/services/mail.ts', source)
  const rule = noSpeculativeCode()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { speculation: { kind: string }[] }
  t.deepEqual(state.speculation.map(item => item.kind), ['unread-options'])
})

test('produces one pass-through candidate when a parameter is only ever handed to one call', t => {
  const source = `
    export const toDomain = (row) => mapRow(row)
  `
  const document = parser.parse('src/services/toDomain.ts', source)
  const rule = noSpeculativeCode()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { speculation: { kind: string }[] }
  t.deepEqual(state.speculation.map(item => item.kind), ['pass-through'])
})

test('produces one flag-parameter candidate when a boolean parameter splits the body in two', t => {
  const source = `
    export const format = (value, asCurrency: boolean) => {
      if (asCurrency) {
        return \`$\${value.toFixed(2)}\`
      }
      return \`\${value}\`
    }
  `
  const document = parser.parse('src/services/format.ts', source)
  const rule = noSpeculativeCode()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { speculation: { kind: string }[] }
  t.deepEqual(state.speculation.map(item => item.kind), ['flag-parameter'])
})

test('produces one literal-condition candidate for an if with a fixed condition', t => {
  const source = `
    export const run = () => {
      if (false) {
        legacyPath()
      }
      return mainPath()
    }
  `
  const document = parser.parse('src/services/run.ts', source)
  const rule = noSpeculativeCode()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { speculation: { kind: string, source: string }[] }
  t.deepEqual(state.speculation.map(item => item.kind), ['literal-condition'])
  t.is(state.speculation[0].source, 'if (false)')
})

test('produces one default-callback candidate for a parameter defaulted to an arrow function', t => {
  const source = `
    export const retry = (fn, onRetry = () => {}) => {
      try {
        return fn()
      } catch (error) {
        onRetry(error)
        throw error
      }
    }
  `
  const document = parser.parse('src/services/retry.ts', source)
  const rule = noSpeculativeCode()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { speculation: { kind: string }[] }
  t.deepEqual(state.speculation.map(item => item.kind), ['default-callback'])
})

test('produces one unused-generic candidate when a type parameter occurs once after its declaration', t => {
  const source = `
    export const first = <T>(items: unknown[]) => items[0] as T
  `
  const document = parser.parse('src/services/first.ts', source)
  const rule = noSpeculativeCode()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { speculation: { kind: string }[] }
  t.deepEqual(state.speculation.map(item => item.kind), ['unused-generic'])
})

test('produces no candidates when both destructured option keys are read', t => {
  const source = `
    export const paginate = (items, { page, size }) => {
      return items.slice((page - 1) * size, page * size)
    }
  `
  const document = parser.parse('src/services/paginate.ts', source)
  const rule = noSpeculativeCode()

  t.deepEqual(rule.collect(document), [])
})

test('produces no candidates when a generic constrains two positions', t => {
  const source = `
    export const identity = <T>(value: T): T => value
  `
  const document = parser.parse('src/services/identity.ts', source)
  const rule = noSpeculativeCode()

  t.deepEqual(rule.collect(document), [])
})

test('still produces a flag-parameter candidate for a flag read from real input, leaving the safe label to the model', t => {
  const source = `
    export const render = (item, compact: boolean) => {
      const label = compact ? 'Compact' : 'Full'
      if (compact) {
        return \`\${label}: \${item.summary}\`
      }
      return \`\${label}: \${item.summary} - \${item.details}\`
    }
  `
  const document = parser.parse('src/services/render.ts', source)
  const rule = noSpeculativeCode()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { speculation: { kind: string }[] }
  t.deepEqual(state.speculation.map(item => item.kind), ['flag-parameter'])
})

test('a custom optionsParameterPatterns turns an unmatched parameter name into an unread-options candidate', t => {
  const source = `
    export const sendEmail = (to, body, cfg) => {
      return \`sending to \${to}: \${body}\`
    }
  `
  const document = parser.parse('src/services/mailCfg.ts', source)

  const defaultCandidates = noSpeculativeCode().collect(document)
  t.deepEqual(defaultCandidates, [])

  const strictCandidates = noSpeculativeCode({ optionsParameterPatterns: ['^cfg$'] }).collect(document)
  t.is(strictCandidates.length, 1)
  const state = strictCandidates[0].state as { speculation: { kind: string }[] }
  t.deepEqual(state.speculation.map(item => item.kind), ['unread-options'])
})

test('positions the single candidate on the function carrying the speculative flexibility', t => {
  const source = `
    export const describe = (name) => {
      return \`hello \${name}\`
    }

    export const format = (value, asCurrency: boolean) => {
      if (asCurrency) {
        return \`$\${value.toFixed(2)}\`
      }
      return \`\${value}\`
    }
  `
  const document = parser.parse('src/services/mixed.ts', source)
  const rule = noSpeculativeCode()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as FunctionTarget).name, 'format')
})

test('diagnose returns a warning at probability 0.90 with confidence 0.8', t => {
  const rule = noSpeculativeCode()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('speculative_flexibility', 0.90, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'warning')
})

test('diagnose returns an error at probability 0.96 with confidence 0.8', t => {
  const rule = noSpeculativeCode()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('speculative_flexibility', 0.96, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'error')
})

test('diagnose returns null below the warning threshold at probability 0.84', t => {
  const rule = noSpeculativeCode()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('speculative_flexibility', 0.84, 0.8), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null below minimum confidence at confidence 0.6', t => {
  const rule = noSpeculativeCode()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('speculative_flexibility', 0.96, 0.6), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the flexibility_is_exercised label', t => {
  const rule = noSpeculativeCode()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('flexibility_is_exercised', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the public_api_surface_by_contract label', t => {
  const rule = noSpeculativeCode()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('public_api_surface_by_contract', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for a wrong answer type', t => {
  const rule = noSpeculativeCode()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose({ type: 'noul', noul: 0.99 }, candidate)

  t.is(diagnostic, null)
})

test('offers the model exactly four labels', t => {
  const candidate = fixtureCandidate()

  const labels = candidate.question.type === 'choice' ? Object.keys(candidate.question.criteria).sort() : []

  t.deepEqual(labels, [
    'flexibility_is_exercised',
    'insufficient_context',
    'public_api_surface_by_contract',
    'speculative_flexibility'
  ])
})

test('registers no-speculative-code through the ideology plugin with a description', t => {
  const plugin = ideology()

  const rule = plugin.rules['no-speculative-code']()

  t.is(typeof rule.description, 'string')
  t.true(rule.description.length > 0)
})
