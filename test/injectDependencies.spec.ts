import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import type { ChoiceAnswer, FunctionTarget, RuleCandidate } from '@scruple/core'
import { injectDependencies } from '../src/rules/injectDependencies.ts'
import { ideology } from '../src/index.ts'

const parser = oxcParser()

const fixtureCandidate = (): RuleCandidate => {
  const document = parser.parse('src/services/petClientFactory.ts', `
    function wirePetClient() {
      const client = new HttpPetClient()
      return client
    }
  `)
  const rule = injectDependencies()
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

test('produces no candidates for a composition-root document even with a constructor inside a function', t => {
  const source = `
    function wireApp() {
      const client = new HttpPetClient()
      return client
    }
  `
  const document = parser.parse('src/index.ts', source)
  const rule = injectDependencies()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces no candidates for a function with no constructor and no factory call', t => {
  const source = `
    function greet(petService: PetService) {
      return petService.describe()
    }
  `
  const document = parser.parse('src/services/greeter.ts', source)
  const rule = injectDependencies()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces one candidate for a function constructing a collaborator with new', t => {
  const source = `
    function wirePetService() {
      const client = new HttpPetClient()
      return client
    }
  `
  const document = parser.parse('src/services/petServiceFactory.ts', source)
  const rule = injectDependencies()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const [candidate] = candidates
  t.is(candidate.question.type, 'choice')
  const state = candidate.state as { constructions: string[] }
  t.true(state.constructions.some(construction => construction.includes('new HttpPetClient()')))
})

test('produces one candidate for a function calling a dotted factory pattern', t => {
  const source = `
    function wireHttpClient() {
      const client = axios.create({ baseURL: 'https://example.test' })
      return client
    }
  `
  const document = parser.parse('src/services/httpClientFactory.ts', source)
  const rule = injectDependencies()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
})

test('produces one candidate for a function calling a create-prefixed factory pattern', t => {
  const source = `
    function wireUser() {
      const user = createUser({ name: 'a' })
      return user
    }
  `
  const document = parser.parse('src/services/userFactory.ts', source)
  const rule = injectDependencies()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
})

test('positions the single candidate on the function that constructs a collaborator', t => {
  const source = `
    function describePet(pet: Pet) {
      return pet.name
    }

    function wirePetClient() {
      const client = new HttpPetClient()
      return client
    }
  `
  const document = parser.parse('src/services/petModule.ts', source)
  const rule = injectDependencies()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as FunctionTarget).name, 'wirePetClient')
})

test('diagnose returns a warning at probability 0.90 with confidence 0.8', t => {
  const rule = injectDependencies()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('constructs_collaborator_internally', 0.90, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'warning')
})

test('diagnose returns an error at probability 0.96 with confidence 0.8', t => {
  const rule = injectDependencies()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('constructs_collaborator_internally', 0.96, 0.8), candidate)

  t.truthy(diagnostic)
  t.is(diagnostic?.severity, 'error')
})

test('diagnose returns null below the warning threshold at probability 0.84', t => {
  const rule = injectDependencies()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('constructs_collaborator_internally', 0.84, 0.8), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null below minimum confidence at confidence 0.6', t => {
  const rule = injectDependencies()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('constructs_collaborator_internally', 0.96, 0.6), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the constructs_plain_value label', t => {
  const rule = injectDependencies()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('constructs_plain_value', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('diagnose returns null for the returns_constructed_object label', t => {
  const rule = injectDependencies()
  const candidate = fixtureCandidate()

  const diagnostic = rule.diagnose(choiceAnswer('returns_constructed_object', 0.96, 0.9), candidate)

  t.is(diagnostic, null)
})

test('registers inject-dependencies through the ideology plugin with a description', t => {
  const plugin = ideology()

  const rule = plugin.rules['inject-dependencies']()

  t.is(typeof rule.description, 'string')
  t.true(rule.description.length > 0)
})

test('produces no candidates for a test file even with a constructor inside a function', t => {
  const source = `
    function buildFixture() {
      const client = new HttpPetClient()
      return client
    }
  `
  const document = parser.parse('src/petService.spec.ts', source)
  const rule = injectDependencies()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces no candidates for a test-double file named with a Fakes, Doubles, Mocks, or Stubs suffix', t => {
  const source = `
    function buildFixture() {
      const client = new HttpPetClient()
      return client
    }
  `
  const rule = injectDependencies()

  for (const filename of ['src/petFakes.ts', 'src/petDoubles.ts', 'src/petMocks.ts', 'src/petStubs.ts']) {
    t.deepEqual(rule.collect(parser.parse(filename, source)), [], filename)
  }
})

test('produces one candidate for a lazy nullish-coalescing assignment on a private field inside a method', t => {
  const source = `
    class ProfileLookup {
      #cache

      async find(userId) {
        this.#cache ??= new RedisCache('redis://localhost:6379')
        return this.#cache.get('profile:' + userId)
      }
    }
  `
  const document = parser.parse('src/services/profileLookup.ts', source)
  const rule = injectDependencies()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { constructions: string[] }
  t.true(
    state.constructions.some(construction =>
      construction.includes('new RedisCache(\'redis://localhost:6379\')')
    )
  )
})

test('produces one candidate on a parameterless constructor and none on a sibling method with no construction', t => {
  const source = `
    class PetService {
      #repository

      constructor() {
        this.#repository = new PostgresPetRepository(pool)
      }

      findByName(name) {
        return this.#repository.findByName(name)
      }
    }
  `
  const document = parser.parse('src/services/petService.ts', source)
  const rule = injectDependencies()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as FunctionTarget).role, 'constructor')
})

test('produces one candidate for a constructor built from a dynamically imported class', t => {
  const source = `
    async function chargeInvoice(invoice) {
      const { StripeClient } = await import('./stripe.js')
      const stripe = new StripeClient(process.env.STRIPE_KEY ?? '')
      const charge = await stripe.charge(invoice.amountCents)
      return charge.id
    }
  `
  const document = parser.parse('src/services/billing.ts', source)
  const rule = injectDependencies()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
})

test('includes the axios.create(...) source in the candidate constructions for a dotted factory pattern', t => {
  const source = `
    async function fetchWeather(city) {
      const http = axios.create({ baseURL: 'https://weather.example.com', timeout: 2000 })
      const response = await http.get('/current/' + city)
      return { tempC: response.data.temp_c }
    }
  `
  const document = parser.parse('src/services/weatherClient.ts', source)
  const rule = injectDependencies()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  const state = candidates[0].state as { constructions: string[] }
  t.true(state.constructions.some(construction => construction.startsWith('axios.create(')))
})

test('produces no candidates for a composition-root document containing only a top-level construction', t => {
  const source = `
    import { HttpMailClient } from './mail.js'
    import { ReportService } from './reportService.js'
    import { config } from './config.js'

    export const reportService = new ReportService(new HttpMailClient(config.smtpUrl))
  `
  const document = parser.parse('src/index.ts', source)
  const rule = injectDependencies()

  const candidates = rule.collect(document)

  t.deepEqual(candidates, [])
})

test('produces exactly one candidate, positioned on the outer function, when a nested callback also constructs a collaborator', t => {
  const source = `
    function wireClients() {
      const primary = new HttpPetClient()
      const backups = [1, 2, 3].map(function () {
        return new HttpPetClient()
      })
      return { primary, backups }
    }
  `
  const document = parser.parse('src/services/petClients.ts', source)
  const rule = injectDependencies()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
  t.is((candidates[0].target as FunctionTarget).name, 'wireClients')
})

test('admits a create-prefixed platform utility call into a candidate via the factory prefilter', t => {
  const source = `
    export const fingerprint = (payload) =>
      createHash('sha256').update(payload).digest('hex')
  `
  const document = parser.parse('src/services/fingerprint.ts', source)
  const rule = injectDependencies()

  const candidates = rule.collect(document)

  t.is(candidates.length, 1)
})
