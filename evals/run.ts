import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, runScruple } from '@scruple/core'
import type { SourceFile } from '@scruple/core'
import { oxcParser } from '@scruple/parser-oxc'
import { jevProvider } from '@scruple/provider-jev'
import { cachedProvider } from '../src/cached-provider/index.ts'
import { ideology } from '../src/index.ts'

interface Fixture {
  id: string
  filename: string
  source: string
  rule_id: string
  expected_finding: boolean
  expected_choice?: string
  expected_choices?: string[]
  expected_candidates?: number
  rationale: string
  tags: string[]
}

interface FixtureFile {
  default_expected_candidates: number
  rule_choices: Record<string, { finding: string; safe: string }>
  fixtures: Fixture[]
}

const evalsDir = fileURLToPath(new URL('.', import.meta.url))

const fixtureFiles: FixtureFile[] = readdirSync(evalsDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(new URL(name, import.meta.url), 'utf8')))

const fixtures = fixtureFiles.flatMap((fixtureFile) =>
  fixtureFile.fixtures.map((fixture) => ({
    fixture,
    expectedCandidates: fixture.expected_candidates ?? fixtureFile.default_expected_candidates
  }))
)

const apiKey = process.env['TYPESAFE_API_KEY']
if (apiKey === undefined) throw new Error('TYPESAFE_API_KEY is required')

const ruleIds = Object.keys(ideology().rules).map((rule) => `ideology/${rule}`)

const config = defineConfig({
  parser: oxcParser(),
  provider: cachedProvider(jevProvider({ apiKey }), { enabled: false }),  // evals are always live
  include: ['**/*.ts'],
  plugins: { ideology: ideology() },
  rules: Object.fromEntries(ruleIds.map((ruleId) => [ruleId, 'warn']))
})

// Fixtures may share a filename; prefixing with the id keeps each one's decisions separable.
const fixtureFilename = (fixture: Fixture): string => `${fixture.id}/${fixture.filename}`

const files: SourceFile[] = fixtures.map(({ fixture }) => ({
  filename: fixtureFilename(fixture),
  source: fixture.source
}))

const result = await runScruple(config, files, undefined, { includeDecisions: true })

let passed = 0
let failed = 0

for (const { fixture, expectedCandidates } of fixtures) {
  const decisions = (result.decisions ?? []).filter(
    decision => decision.filename === fixtureFilename(fixture) && decision.ruleId === fixture.rule_id
  )
  const answers = decisions.map(decision => decision.answer)
  const actualChoices = answers.map(answer => (answer.type === 'choice' ? answer.choice : '(non-choice)'))
  const probabilities = answers.map(answer =>
    answer.type === 'choice' ? answer.probabilities[answer.choice]?.toFixed(2) ?? 'n/a' : 'n/a'
  )
  const finding = decisions.some(decision => decision.diagnostic)

  // One label per candidate, in source order. A single expected_choice is the one-candidate form.
  const expectedChoices =
    fixture.expected_choices ?? (fixture.expected_choice === undefined ? undefined : [fixture.expected_choice])

  const candidateCountOk = decisions.length === expectedCandidates
  const choiceOk =
    expectedChoices === undefined ||
    (expectedChoices.length === actualChoices.length && expectedChoices.every((choice, i) => choice === actualChoices[i]))
  const findingOk = finding === fixture.expected_finding
  const ok = candidateCountOk && choiceOk && findingOk

  if (ok) passed += 1
  else failed += 1

  const expectedText = expectedChoices?.join(',') ?? '(none)'
  const actualText = actualChoices.length === 0 ? '(none)' : actualChoices.join(',')
  const probabilityText = probabilities.length === 0 ? 'n/a' : probabilities.join(',')
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${fixture.id} expected=${expectedText} actual=${actualText} p=${probabilityText}\n`)
}

process.stdout.write(`${passed} passed, ${failed} failed\n`)

if (failed > 0) process.exitCode = 1
