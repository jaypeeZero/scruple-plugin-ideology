import test from 'ava'
import { readFileSync, readdirSync } from 'node:fs'
import { oxcParser } from '@scruple/parser-oxc'
import type { ChoiceAnswer, DecisionRuleOptions, RuleCandidate, RuleFactory } from '@scruple/core'
import { ideology } from '../src/index.ts'

interface Fixture {
  rule_id: string
  filename: string
  source: string
  expected_finding: boolean
}

interface EvalFile {
  rule_choices: Record<string, { finding: string }>
  fixtures: Fixture[]
}

const parser = oxcParser()
const evalsDir = new URL('../evals/', import.meta.url)
const rules = ideology().rules as Record<string, RuleFactory<DecisionRuleOptions>>

const evalFiles: EvalFile[] = readdirSync(evalsDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(readFileSync(new URL(name, evalsDir), 'utf8')) as EvalFile)

const findingLabel = (ruleId: string): string => {
  const file = evalFiles.find((candidate) => candidate.rule_choices[ruleId] !== undefined)
  if (file === undefined) throw new Error(`no eval file declares the finding label for ${ruleId}`)
  return file.rule_choices[ruleId].finding
}

const violationCandidate = async (ruleId: string): Promise<RuleCandidate> => {
  const rule = rules[ruleId.replace(/^ideology\//, '')]()
  const violations = evalFiles
    .flatMap((file) => file.fixtures)
    .filter((fixture) => fixture.rule_id === ruleId && fixture.expected_finding)
  for (const fixture of violations) {
    const [candidate] = await rule.collect(parser.parse(fixture.filename, fixture.source))
    if (candidate !== undefined) return candidate
  }
  throw new Error(`no violation fixture for ${ruleId} produces a candidate`)
}

const answer = (choice: string, probability: number, confidence: number): ChoiceAnswer => ({
  type: 'choice',
  choice,
  confidence,
  probabilities: { [choice]: probability }
})

const ruleIds = Object.keys(rules).map((name) => `ideology/${name}`)

test('every rule warns from 0.7, errors from 0.95, and drops answers below 0.7 confidence by default', async t => {
  t.is(ruleIds.length, 17)
  for (const ruleId of ruleIds) {
    const rule = rules[ruleId.replace(/^ideology\//, '')]()
    const candidate = await violationCandidate(ruleId)
    const finding = findingLabel(ruleId)

    t.is(rule.diagnose(answer(finding, 0.69, 0.8), candidate), null, ruleId)
    t.is(rule.diagnose(answer(finding, 0.7, 0.8), candidate)?.severity, 'warning', ruleId)
    t.is(rule.diagnose(answer(finding, 0.95, 0.8), candidate)?.severity, 'error', ruleId)
    t.is(rule.diagnose(answer(finding, 0.96, 0.69), candidate), null, ruleId)
  }
})

test('every rule uses the threshold and minConfidence passed in its options instead of the defaults', async t => {
  for (const ruleId of ruleIds) {
    const rule = rules[ruleId.replace(/^ideology\//, '')]({
      threshold: { warning: 0.9, error: 0.98 },
      minConfidence: 0.5
    })
    const candidate = await violationCandidate(ruleId)
    const finding = findingLabel(ruleId)

    t.is(rule.diagnose(answer(finding, 0.85, 0.8), candidate), null, ruleId)
    t.is(rule.diagnose(answer(finding, 0.92, 0.6), candidate)?.severity, 'warning', ruleId)
    t.is(rule.diagnose(answer(finding, 0.99, 0.6), candidate)?.severity, 'error', ruleId)
  }
})
