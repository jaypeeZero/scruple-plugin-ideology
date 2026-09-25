import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import type { ChoiceAnswer, FunctionTarget, RuleCandidate } from '@scruple/core'
import { preferDeclarativeTransformation } from '../src/rules/preferDeclarativeTransformation.ts'
import { ideology } from '../src/index.ts'

const parser = oxcParser()

const fixtureCandidate = (): RuleCandidate => {
  const document = parser.parse('src/pets/petService.ts', `
    export const namesOf = (pets) => {
      const names = []
      for (const pet of pets) {
        names.push(pet.name)
      }
      return names
    }
  `)
  const rule = preferDeclarativeTransformation()
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

test('produces no candidates for a test-double file, even with a loop', t => {
  const source = `
    export const namesOf = (pets) => {
      const names = []
      for (const pet of pets) {
        names.push(pet.name)
      }
      return names
    }
  `
  const document = parser.parse('src/pets/petServiceFakes.ts', source)
  const rule = preferDeclarativeTransformation()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces no candidates for a function with no loop and no forEach', t => {
  const source = `
    export const totalWeight = (pets) => {
      return pets.reduce((sum, pet) => sum + pet.weight, 0)
    }
  `
  const document = parser.parse('src/pets/petService.ts', source)
  const rule = preferDeclarativeTransformation()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces one candidate for a for-of loop pushing into an array declared above, with its source in state', t => {
  const source = `
    export const namesOf = (pets) => {
      const names = []
      for (const pet of pets) {
        names.push(pet.name)
      }
      return names
    }
  `
  const document = parser.parse('src/pets/petService.ts', source)
  const rule = preferDeclarativeTransformation()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { loops: Array<{ kind: string, source: string }> }
  t.is(state.loops[0].kind, 'for-of')
  t.true(state.loops[0].source.includes('names.push(pet.name)'))
})

test('produces one candidate for a function calling .forEach, with kind forEach', t => {
  const source = `
    export const registerAll = (routes, server) => {
      routes.forEach(function (route) {
        server.register(route)
      })
    }
  `
  const document = parser.parse('src/app/server.ts', source)
  const rule = preferDeclarativeTransformation()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { loops: Array<{ kind: string }> }
  t.is(state.loops[0].kind, 'forEach')
})

test('produces exactly one candidate, positioned on the looping function, when a second function has none', t => {
  const source = `
    export const totalWeight = (pets) => {
      return pets.reduce((sum, pet) => sum + pet.weight, 0)
    }

    export const namesOf = (pets) => {
      const names = []
      for (const pet of pets) {
        names.push(pet.name)
      }
      return names
    }
  `
  const document = parser.parse('src/pets/petService.ts', source)
  const rule = preferDeclarativeTransformation()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as FunctionTarget).name, 'namesOf')
})

test('produces exactly one candidate, positioned on the outer function, when a nested callback contains the loop', t => {
  const source = `
    export const namesOfBatches = (batches) => {
      return batches.map(function (pets) {
        const names = []
        for (const pet of pets) {
          names.push(pet.name)
        }
        return names
      })
    }
  `
  const document = parser.parse('src/pets/petBatch.ts', source)
  const rule = preferDeclarativeTransformation()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as FunctionTarget).name, 'namesOfBatches')
})

test('produces one candidate with two entries in state.loops for a function with two loops', t => {
  const source = `
    export const namesAndWeights = (pets, weights) => {
      const names = []
      for (const pet of pets) {
        names.push(pet.name)
      }
      const totals = []
      for (const weight of weights) {
        totals.push(weight * 2)
      }
      return { names, totals }
    }
  `
  const document = parser.parse('src/pets/petService.ts', source)
  const rule = preferDeclarativeTransformation()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { loops: unknown[] }
  t.is(state.loops.length, 2)
})

test('diagnose returns a warning at probability 0.90 with confidence 0.8', t => {
  const rule = preferDeclarativeTransformation()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('loop_is_disguised_transformation', 0.90, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'warning')
})

test('diagnose returns an error at probability 0.96 with confidence 0.8', t => {
  const rule = preferDeclarativeTransformation()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('loop_is_disguised_transformation', 0.96, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'error')
})

test('diagnose returns null below the warning threshold at probability 0.84', t => {
  const rule = preferDeclarativeTransformation()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('loop_is_disguised_transformation', 0.84, 0.8), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null below minimum confidence at confidence 0.6', t => {
  const rule = preferDeclarativeTransformation()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('loop_is_disguised_transformation', 0.96, 0.6), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the loop_performs_effects label', t => {
  const rule = preferDeclarativeTransformation()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('loop_performs_effects', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the loop_needs_imperative_control label', t => {
  const rule = preferDeclarativeTransformation()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('loop_needs_imperative_control', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('offers the model exactly four labels', t => {
  const candidate = fixtureCandidate()

  const labels = candidate.question.type === 'choice' ? Object.keys(candidate.question.criteria).sort() : []

  t.deepEqual(labels, [
    'insufficient_context',
    'loop_is_disguised_transformation',
    'loop_needs_imperative_control',
    'loop_performs_effects'
  ])
})

test('registers prefer-declarative-transformation through the ideology plugin with a description', t => {
  const plugin = ideology()

  const rule = plugin.rules['prefer-declarative-transformation']()

  t.is(typeof rule.description, 'string')
  t.true(rule.description.length > 0)
})
