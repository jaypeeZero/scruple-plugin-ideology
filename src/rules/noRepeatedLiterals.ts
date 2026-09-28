import { resolveDecisionOptions, resolveDiagnosticSeverity } from '@scruple/core'
import type {
  ChoiceQuestion,
  DecisionRuleOptions,
  Diagnostic,
  ParsedDocument,
  RuleCandidate,
  RuleFactory,
  SemanticRule
} from '@scruple/core'
import { boundedText } from '../bounded.ts'
import { topLevelFunctions } from '../functions.ts'
import { moduleScopeSource } from '../moduleScope.ts'
import { matchesAny } from '../patterns.ts'
import { stringLiteralContents, stripStringLiterals } from '../stringLiterals.ts'
import { defaultTestFilePattern } from '../testFiles.ts'

export interface NoRepeatedLiteralsOptions extends DecisionRuleOptions {
  testFilePattern?: string
  minFunctions?: number
  minLength?: number
  ignoredLiteralPatterns?: string[]
}

const defaultThreshold = { warning: 0.85, error: 0.95 }
const defaultMinConfidence = 0.7
const defaultMinFunctions = 2
const defaultMinLength = 2
const defaultIgnoredLiteralPatterns = [
  '^$',
  '^[01]$',
  '^-1$',
  '^\\s*$',
  '^[.,;:!?()\\[\\]{}/\\\\-]$',
  '^\\n$'
]

const instructions =
  'Are any of these literals, repeated across several functions in this file, values that carry meaning and would all need to change together?'

const criteria = {
  repeated_meaningful_literal:
    'At least one repeated literal is a key, status, path, header, unit, threshold, or other value whose meaning is shared: changing it in one function without the others would be a bug.',
  coincidental_or_structural:
    'Every repeated literal is incidental: a common word in unrelated messages, a formatting character, a small number used for different reasons.',
  insufficient_context:
    'The literals\' roles cannot be determined from the functions shown.'
}

const finding = 'repeated_meaningful_literal'
const message = 'Name this repeated literal once as a constant and reference it.'

// Digits inside a string are not a numeric literal, so this pattern only ever runs
// over source that has already had its string and template contents blanked out.
const numericLiteralPattern = /\b\d+(?:\.\d+)?\b/g

interface Literal {
  kind: 'string' | 'number'
  value: string
}

// Tagged by kind so a string literal never collides with a numeric literal that
// happens to spell the same characters.
const literalKey = (literal: Literal): string => `${literal.kind}:${literal.value}`

const literalsIn = (source: string): Literal[] => {
  const strings = stringLiteralContents(source).map((value) => ({ kind: 'string' as const, value }))
  const numbers = [...stripStringLiterals(source).matchAll(numericLiteralPattern)].map((match) => ({
    kind: 'number' as const,
    value: match[0]
  }))
  return [...strings, ...numbers]
}

interface Occurrence {
  functionIndex: number
  functionName: string
}

interface EvidenceGroup {
  literal: string
  functions: string[]
  count: number
  firstFunctionIndex: number
}

export const noRepeatedLiterals: RuleFactory<NoRepeatedLiteralsOptions> = (
  options = {}
): SemanticRule => {
  const { threshold, minConfidence } = resolveDecisionOptions(options, {
    threshold: defaultThreshold,
    minConfidence: defaultMinConfidence
  })
  const testFilePattern = new RegExp(options.testFilePattern ?? defaultTestFilePattern)
  const minFunctions = options.minFunctions ?? defaultMinFunctions
  const minLength = options.minLength ?? defaultMinLength
  const ignoredLiteralPatterns = (options.ignoredLiteralPatterns ?? defaultIgnoredLiteralPatterns).map(
    (pattern) => new RegExp(pattern)
  )

  return {
    description: 'A literal repeated across functions with shared meaning belongs in one named constant.',
    collect(document: ParsedDocument): RuleCandidate[] {
      if (testFilePattern.test(document.filename)) return []

      const functions = topLevelFunctions(document)
      if (functions.length === 0) return []

      // Already named as a module-level constant, so it is not hidden repetition.
      const moduleLiterals = new Set(literalsIn(moduleScopeSource(document)).map(literalKey))

      const isIgnored = (literal: Literal): boolean =>
        matchesAny(ignoredLiteralPatterns, literal.value) || literal.value.length < minLength

      const occurrences = new Map<string, Occurrence[]>()

      functions.forEach((fn, functionIndex) => {
        for (const literal of literalsIn(fn.source)) {
          if (isIgnored(literal)) continue

          const key = literalKey(literal)
          if (moduleLiterals.has(key)) continue

          const list = occurrences.get(key) ?? []
          list.push({ functionIndex, functionName: fn.name ?? '' })
          occurrences.set(key, list)
        }
      })

      const evidence: EvidenceGroup[] = []
      for (const [key, list] of occurrences) {
        const distinctFunctions = [...new Set(list.map((occurrence) => occurrence.functionName))]
        if (distinctFunctions.length < minFunctions) continue

        evidence.push({
          literal: key.slice(key.indexOf(':') + 1),
          functions: distinctFunctions,
          count: list.length,
          firstFunctionIndex: list[0].functionIndex
        })
      }

      if (evidence.length === 0) return []

      const evidenceByFirstFunction = new Map<number, EvidenceGroup[]>()
      for (const group of evidence) {
        const list = evidenceByFirstFunction.get(group.firstFunctionIndex) ?? []
        list.push(group)
        evidenceByFirstFunction.set(group.firstFunctionIndex, list)
      }

      return functions.flatMap((fn, functionIndex) => {
        const groups = evidenceByFirstFunction.get(functionIndex)
        if (groups === undefined) return []

        const question: ChoiceQuestion = {
          type: 'choice',
          instructions,
          criteria
        }

        const { text, truncated } = boundedText(fn.source, 4000)

        return [
          {
            target: fn,
            state: {
              language: fn.language,
              function: { text, truncated },
              repeated: groups.map(({ literal, functions: functionNames, count }) => ({
                literal,
                functions: functionNames,
                count
              }))
            },
            question
          }
        ]
      })
    },
    diagnose(answer, candidate): Omit<Diagnostic, 'ruleId' | 'model'> | null {
      if (answer.type !== 'choice' || answer.choice !== finding) return null

      const probability = answer.probabilities[finding] ?? 0
      const severity = resolveDiagnosticSeverity(probability, answer.confidence, {
        threshold,
        minConfidence
      })
      if (severity === null) return null

      return {
        message,
        filename: candidate.target.filename,
        location: candidate.target.location,
        probability,
        confidence: answer.confidence,
        severity
      }
    }
  }
}
