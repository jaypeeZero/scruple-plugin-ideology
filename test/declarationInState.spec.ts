import test from 'ava'
import { readFileSync, readdirSync } from 'node:fs'
import { oxcParser } from '@scruple/parser-oxc'
import type { FunctionTarget, RuleFactory } from '@scruple/core'
import { declarationOf } from '../src/declaration.ts'
import { ideology } from '../src/index.ts'

interface Fixture {
  id: string
  rule_id: string
  filename: string
  source: string
}

const parser = oxcParser()
const evalsDir = new URL('../evals/', import.meta.url)
const rules = ideology().rules as Record<string, RuleFactory>

const fixtures: Fixture[] = readdirSync(evalsDir)
  .filter((name) => name.endsWith('.json'))
  .flatMap((name) => (JSON.parse(readFileSync(new URL(name, evalsDir), 'utf8')) as { fixtures: Fixture[] }).fixtures)

test('every function candidate tells the provider where and how its function is declared', async t => {
  const rulesWithFunctionCandidates = new Set<string>()

  for (const fixture of fixtures) {
    const ruleName = fixture.rule_id.replace(/^ideology\//, '')
    const document = parser.parse(fixture.filename, fixture.source)
    const candidates = await rules[ruleName]().collect(document)

    for (const candidate of candidates) {
      if (candidate.target.kind !== 'function') continue
      rulesWithFunctionCandidates.add(ruleName)
      const state = candidate.state as { declaration?: unknown }
      t.deepEqual(
        state.declaration,
        declarationOf(document, candidate.target as FunctionTarget),
        `${fixture.rule_id} / ${fixture.id}`
      )
    }
  }

  t.is(rulesWithFunctionCandidates.size, 16)
})
