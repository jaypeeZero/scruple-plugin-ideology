import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, runScruple } from '@scruple/core'
import type { SourceFile } from '@scruple/core'
import { oxcParser } from '@scruple/parser-oxc'
import { claudeCliProvider } from 'scruple-provider-claude-cli'
import { defaultThreshold } from '../src/decisionDefaults.ts'
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
    findingChoice: fixtureFile.rule_choices[fixture.rule_id]?.finding
  }))
)

const ruleIds = Object.keys(ideology().rules).map((rule) => `ideology/${rule}`)

// A margin this close to the warning threshold flips between runs of the same code.
const NEAR_CUTOFF = 0.05

const config = defineConfig({
  parser: oxcParser(),
  provider: claudeCliProvider(),  // evals are always live, never cached
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

const reports = fixtures.map(({ fixture, findingChoice }) => {
  const decisions = (result.decisions ?? []).filter(
    decision => decision.filename === fixtureFilename(fixture) && decision.ruleId === fixture.rule_id
  )
  const answers = decisions.map(decision => decision.answer)
  const actualChoices = answers.map(answer => (answer.type === 'choice' ? answer.choice : '(non-choice)'))
  const margins = answers.map(answer =>
    answer.type === 'choice' && findingChoice !== undefined
      ? (answer.probabilities[findingChoice] ?? 0) - defaultThreshold.warning
      : undefined
  )
  const finding = decisions.some(decision => decision.diagnostic)

  // One label per candidate, in source order. A single expected_choice is the one-candidate form.
  const expectedChoices =
    fixture.expected_choices ?? (fixture.expected_choice === undefined ? undefined : [fixture.expected_choice])

  const choiceOk =
    expectedChoices === undefined ||
    (expectedChoices.length === actualChoices.length && expectedChoices.every((choice, i) => choice === actualChoices[i]))
  const right = choiceOk && finding === fixture.expected_finding
  const nearCutoff = margins.some(margin => margin !== undefined && Math.abs(margin) < NEAR_CUTOFF)

  const expectedText = expectedChoices?.join(',') ?? '(none)'
  const actualText = actualChoices.length === 0 ? '(none)' : actualChoices.join(',')
  const marginText = margins.length === 0 ? 'n/a' : margins.map(margin => margin?.toFixed(2) ?? 'n/a').join(',')
  process.stdout.write(`${right ? 'right' : 'WRONG'} ${fixture.id} expected=${expectedText} actual=${actualText} margin=${marginText}\n`)

  return { right, nearCutoff }
})

const rightCount = reports.filter(report => report.right).length
const nearCount = reports.filter(report => report.nearCutoff).length
process.stdout.write(`${rightCount}/${reports.length} right; ${nearCount} within ${NEAR_CUTOFF} of the ${defaultThreshold.warning} cutoff\n`)
