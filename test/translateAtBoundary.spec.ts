import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import type { ChoiceAnswer, FunctionTarget, RuleCandidate } from '@scruple/core'
import { translateAtBoundary } from '../src/rules/translateAtBoundary.ts'
import { ideology } from '../src/index.ts'

const parser = oxcParser()

const fixtureCandidate = (): RuleCandidate => {
  const document = parser.parse('src/pets/petService.ts', `
    export const parsePetPayload = (raw) => {
      const data = JSON.parse(raw)
      return data
    }
  `)
  const rule = translateAtBoundary()
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

test('produces no candidates for a test-double file, even with a parse call', t => {
  const source = `
    export const parsePetPayload = (raw) => {
      const data = JSON.parse(raw)
      return data
    }
  `
  const document = parser.parse('src/pets/petServiceFakes.ts', source)
  const rule = translateAtBoundary()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces no candidates for a function with only domain operations', t => {
  const source = `
    export const totalWeight = (pets) => {
      return pets.reduce((sum, pet) => sum + pet.weight, 0)
    }
  `
  const document = parser.parse('src/pets/petService.ts', source)
  const rule = translateAtBoundary()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces one candidate for a function calling JSON.parse, with the call in state', t => {
  const document = parser.parse('src/pets/petService.ts', `
    export const parsePetPayload = (raw) => {
      const data = JSON.parse(raw)
      return data
    }
  `)
  const rule = translateAtBoundary()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { parseCalls: string[] }
  t.true(state.parseCalls.some(source => source.includes('JSON.parse(raw)')))
})

test('produces one candidate for a function touching request.payload, with payload in state', t => {
  const document = parser.parse('src/pets/petService.ts', `
    export const petName = (request) => {
      return request.payload.name
    }
  `)
  const rule = translateAtBoundary()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { externalShapes: string[] }
  t.true(state.externalShapes.includes('payload'))
})

test('produces exactly one candidate, positioned on the decoding function, when a second function is pure domain logic', t => {
  const document = parser.parse('src/pets/petService.ts', `
    export const totalWeight = (pets) => {
      return pets.reduce((sum, pet) => sum + pet.weight, 0)
    }

    export const parsePetPayload = (raw) => {
      const data = JSON.parse(raw)
      return data
    }
  `)
  const rule = translateAtBoundary()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as FunctionTarget).name, 'parsePetPayload')
})

test('produces one candidate for a handler-style file with JSON.parse(request.payload) inside a function', t => {
  const source = `
    export const handlePet = (request) => {
      const data = JSON.parse(request.payload)
      return data
    }
  `
  const document = parser.parse('src/handlers/petHandler.ts', source)
  const rule = translateAtBoundary()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
})

test('produces one candidate for a function that only maps a database row to typed fields and returns', t => {
  const source = `
    export const toPet = (row) => {
      return { firstName: row.first_name }
    }
  `
  const document = parser.parse('src/pets/petMapper.ts', source)
  const rule = translateAtBoundary()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
})

test('produces exactly one candidate, positioned on the outer function, when a nested callback also matches the prefilter', t => {
  const source = `
    export const parsePetPayloads = (request) => {
      const raws = request.payload.raws
      return raws.map(function (raw) {
        return JSON.parse(raw)
      })
    }
  `
  const document = parser.parse('src/pets/petBatch.ts', source)
  const rule = translateAtBoundary()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as FunctionTarget).name, 'parsePetPayloads')
})

test('offers the model exactly four labels', t => {
  const candidate = fixtureCandidate()

  const labels = candidate.question.type === 'choice' ? Object.keys(candidate.question.criteria).sort() : []

  t.deepEqual(labels, ['insufficient_context', 'mixes_decoding_with_domain_logic', 'only_translates', 'operates_on_domain_values'])
})

test('diagnose returns a warning at probability 0.90 with confidence 0.8', t => {
  const rule = translateAtBoundary()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('mixes_decoding_with_domain_logic', 0.90, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'warning')
})

test('diagnose returns an error at probability 0.96 with confidence 0.8', t => {
  const rule = translateAtBoundary()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('mixes_decoding_with_domain_logic', 0.96, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'error')
})

test('diagnose returns null below the warning threshold at probability 0.84', t => {
  const rule = translateAtBoundary()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('mixes_decoding_with_domain_logic', 0.84, 0.8), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null below minimum confidence at confidence 0.6', t => {
  const rule = translateAtBoundary()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('mixes_decoding_with_domain_logic', 0.96, 0.6), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the operates_on_domain_values label', t => {
  const rule = translateAtBoundary()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('operates_on_domain_values', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the only_translates label', t => {
  const rule = translateAtBoundary()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('only_translates', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('registers translate-at-boundary through the ideology plugin with a description', t => {
  const plugin = ideology()

  const rule = plugin.rules['translate-at-boundary']()

  t.is(typeof rule.description, 'string')
  t.true(rule.description.length > 0)
})
