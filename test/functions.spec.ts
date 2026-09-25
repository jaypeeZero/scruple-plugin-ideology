import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import { topLevelFunctions } from '../src/functions.ts'

const parser = oxcParser()

test('returns only the outer function when a callback is declared inside it', t => {
  const document = parser.parse('src/services/totals.ts', `
    export const totalWeight = (pets) => {
      return pets.reduce((sum, pet) => sum + pet.weight, 0)
    }
  `)

  const functions = topLevelFunctions(document)

  t.is(functions.length, 1)
  t.is(functions[0].name, 'totalWeight')
})

test('returns both sibling top-level functions', t => {
  const document = parser.parse('src/services/petModule.ts', `
    function describePet(pet) {
      return pet.name
    }

    function wirePetClient() {
      return new HttpPetClient()
    }
  `)

  const functions = topLevelFunctions(document)

  t.is(functions.length, 2)
})

test('returns both methods of a class, since methods are not nested in each other', t => {
  const document = parser.parse('src/services/petService.ts', `
    class PetService {
      findByName(name) {
        return this.#repository.findByName(name)
      }

      register(pet) {
        return this.#repository.save(pet)
      }
    }
  `)

  const functions = topLevelFunctions(document)

  t.is(functions.length, 2)
})

test('returns an empty array for an empty document', t => {
  const document = parser.parse('src/services/empty.ts', '')

  t.deepEqual(topLevelFunctions(document), [])
})
