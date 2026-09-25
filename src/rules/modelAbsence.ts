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
import { defaultTestFilePattern } from '../testFiles.ts'

export interface ModelAbsenceOptions extends DecisionRuleOptions {
  testFilePattern?: string
}

const defaultThreshold = { warning: 0.85, error: 0.95 }
const defaultMinConfidence = 0.7

const instructions =
  'When one of these values is missing, does this function replace it with a fabricated value so that callers can no longer tell it was absent?'

const criteria = {
  default_hides_missing_value:
    'A value that carries domain meaning (an identifier, an amount, a name, a status, a date, a record) is missing and the function substitutes a made-up stand-in (empty string, zero, empty array or object, a placeholder) and continues as if it were present.',
  default_is_a_declared_option:
    'The defaulted value is a setting the caller may omit by contract (a page size, timeout, retry count, flag, formatting choice, optional collaborator) and the default is the documented behaviour of omitting it.',
  absence_is_modelled:
    'The function keeps absence visible: it returns null or undefined, an empty result that callers must check, a discriminated result, or it throws or fails fast.',
  insufficient_context:
    'The function shown does not establish what the defaulted value means or who consumes it.'
}

const finding = 'default_hides_missing_value'
const message = 'Model this value\'s absence explicitly instead of substituting a default.'

interface DefaultEvidence {
  kind: 'nullish' | 'or' | 'parameter'
  source: string
}

// Matches the literal starts a defaulted value may take: string/template literal,
// a digit, an array or object literal, or the booleans. `null` is deliberately
// excluded — assigning `null` as a default does not fabricate a value, it models
// absence with one.
const literalStart = '(?:\'[^\']*\'|"[^"]*"|`[^`]*`|\\d+(?:\\.\\d+)?|\\[[^\\]]*\\]|\\{[^}]*\\}|true\\b|false\\b)'
const orLiteralRegex = new RegExp(`\\|\\|\\s*${literalStart}`)
const parameterDefaultRegex = new RegExp(`[A-Za-z_$][\\w$]*\\s*=\\s*${literalStart}`, 'g')

// A single scan for the parameter list's matching close paren: brackets nest, but
// the fixtures this rule sees never hide parens inside a string, so a plain
// depth counter is enough.
const parameterListText = (source: string): string => {
  const openParen = source.indexOf('(')
  const arrow = source.indexOf('=>')
  if (openParen === -1 || (arrow !== -1 && arrow < openParen)) {
    return arrow === -1 ? '' : source.slice(0, arrow)
  }

  let depth = 0
  for (let i = openParen; i < source.length; i++) {
    if (source[i] === '(') depth++
    else if (source[i] === ')') {
      depth--
      if (depth === 0) return source.slice(openParen + 1, i)
    }
  }
  return source.slice(openParen + 1)
}

const nullishDefaults = (source: string): DefaultEvidence[] =>
  source.split('\n').flatMap((line) => {
    const occurrences = line.split('??').length - 1
    return occurrences > 0 ? Array.from({ length: occurrences }, () => ({ kind: 'nullish' as const, source: line.trim() })) : []
  })

const orDefaults = (source: string): DefaultEvidence[] =>
  source.split('\n').flatMap((line) => (orLiteralRegex.test(line) ? [{ kind: 'or' as const, source: line.trim() }] : []))

const parameterDefaults = (source: string): DefaultEvidence[] => {
  const paramText = parameterListText(source)
  return Array.from(paramText.matchAll(parameterDefaultRegex), (match) => ({
    kind: 'parameter' as const,
    source: match[0].trim()
  }))
}

const defaultsIn = (source: string): DefaultEvidence[] => [
  ...nullishDefaults(source),
  ...orDefaults(source),
  ...parameterDefaults(source)
]

export const modelAbsence: RuleFactory<ModelAbsenceOptions> = (options = {}): SemanticRule => {
  const { threshold, minConfidence } = resolveDecisionOptions(options, {
    threshold: defaultThreshold,
    minConfidence: defaultMinConfidence
  })
  const testFilePattern = new RegExp(options.testFilePattern ?? defaultTestFilePattern)

  return {
    description: 'A function that defaults a missing value to a fabricated stand-in should model the absence instead.',
    collect(document: ParsedDocument): RuleCandidate[] {
      if (testFilePattern.test(document.filename)) return []

      return topLevelFunctions(document).flatMap((fn) => {
        const defaults = defaultsIn(fn.source)
        if (defaults.length === 0) return []

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
              defaults: defaults.map((entry) => ({ kind: entry.kind, source: entry.source }))
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
