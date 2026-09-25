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

export interface TranslateAtBoundaryOptions extends DecisionRuleOptions {
  testFilePattern?: string
  parseCallPatterns?: string[]
  externalShapePatterns?: string[]
}

const defaultThreshold = { warning: 0.85, error: 0.95 }
const defaultMinConfidence = 0.7
const defaultParseCallPatterns = [
  '^JSON\\.parse$',
  '^parseInt$',
  '^parseFloat$',
  '^Number$',
  '^Date\\.parse$',
  '\\.split$',
  '\\.validate(Async)?$',
  '\\.parse$'
]
const defaultExternalShapePatterns = [
  '\\b(payload|query|headers|params|body|statusCode)\\b',
  '\\breq(uest)?\\.',
  '\\bres(ponse)?\\.(data|body)\\b',
  '\\brow(s)?\\b'
]

const instructions =
  'Does this function both interpret an external representation (wire, storage, or text format) and, on the decoded value, make a business rule decision or computation about the domain — pricing, eligibility, selecting among domain entities, a state transition, persistence, or a domain effect — in the same body, rather than only translating between representations?'

const criteria = {
  mixes_decoding_with_domain_logic:
    'The function reads or decodes an external shape (request payload, query string, header, database row, JSON text, string-encoded number or date) and then, on that decoded value, makes a business rule decision or computation about the domain — pricing, eligibility, selecting among domain entities, a state transition, persistence, or a domain effect — in the same body.',
  only_translates:
    'The function\'s whole job is converting one representation to another, in either direction, and returning the result. Validating the shape or range of the input and rejecting or throwing when it is malformed, applying a default, converting an error into a response or status, delegating the typed value to an injected collaborator and returning its result, logging, and generating or propagating ids, headers, or request metadata are all part of translating and do not count as a business rule.',
  operates_on_domain_values:
    'Every input is already a typed domain value; string or number operations here are domain logic, not decoding.',
  insufficient_context:
    'The imports, parameter types, and body do not establish whether an external representation is involved.'
}

const finding = 'mixes_decoding_with_domain_logic'
const message = 'Translate this external format in its own function and pass the typed value in.'

// Matched against a single value (a callee name), so a plain, non-global test suffices.
const matchesAny = (patterns: RegExp[], value: string): boolean =>
  patterns.some((pattern) => pattern.test(value))

// Matched against function source, where the same identifier can appear more than once;
// every distinct matched substring is collected once, in encounter order.
const allMatches = (patterns: RegExp[], source: string): string[] => {
  const found = new Set<string>()
  for (const pattern of patterns) {
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
    for (const match of source.matchAll(global)) {
      found.add(match[0])
    }
  }
  return [...found]
}

export const translateAtBoundary: RuleFactory<TranslateAtBoundaryOptions> = (
  options = {}
): SemanticRule => {
  const { threshold, minConfidence } = resolveDecisionOptions(options, {
    threshold: defaultThreshold,
    minConfidence: defaultMinConfidence
  })
  const testFilePattern = new RegExp(options.testFilePattern ?? defaultTestFilePattern)
  const parseCallPatterns = (options.parseCallPatterns ?? defaultParseCallPatterns).map(
    (pattern) => new RegExp(pattern)
  )
  const externalShapePatterns = (options.externalShapePatterns ?? defaultExternalShapePatterns).map(
    (pattern) => new RegExp(pattern)
  )

  return {
    description: 'A function should either translate an external format or apply business rules, never both in the same body.',
    collect(document: ParsedDocument): RuleCandidate[] {
      if (testFilePattern.test(document.filename)) return []

      return topLevelFunctions(document).flatMap((fn) => {
        const parseCalls = fn.calls
          .filter((call) => matchesAny(parseCallPatterns, call.callee))
          .map((call) => call.source)
        const externalShapes = allMatches(externalShapePatterns, fn.source)

        if (parseCalls.length === 0 && externalShapes.length === 0) return []

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
              imports: document.imports,
              function: { text, truncated },
              parseCalls,
              externalShapes
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
