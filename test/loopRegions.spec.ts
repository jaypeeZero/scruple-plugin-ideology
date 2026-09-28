import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import { loopRegionsWithin } from '../src/loopRegions.ts'
import { topLevelFunctions } from '../src/functions.ts'

const parser = oxcParser()

test('returns the loop region inside a function with a for-of loop', t => {
  const document = parser.parse('src/pets/petService.ts', `
    export const namesOf = (pets) => {
      const names = []
      for (const pet of pets) {
        names.push(pet.name)
      }
      return names
    }
  `)
  const [fn] = topLevelFunctions(document)

  const loops = loopRegionsWithin(document, fn)

  t.is(loops.length, 1)
  t.is(loops[0].loop, 'for-of')
})

test('returns an empty array for a function with no loop', t => {
  const document = parser.parse('src/pets/petService.ts', `
    export const totalWeight = (pets) => {
      return pets.reduce((sum, pet) => sum + pet.weight, 0)
    }
  `)
  const [fn] = topLevelFunctions(document)

  t.deepEqual(loopRegionsWithin(document, fn), [])
})

test('does not attribute a loop in one sibling function to another', t => {
  const document = parser.parse('src/pets/mixed.ts', `
    export const describe = (name) => {
      return 'hello ' + name
    }

    export const namesOf = (pets) => {
      const names = []
      for (const pet of pets) {
        names.push(pet.name)
      }
      return names
    }
  `)
  const [describe, namesOf] = topLevelFunctions(document)

  t.deepEqual(loopRegionsWithin(document, describe), [])
  t.is(loopRegionsWithin(document, namesOf).length, 1)
})
