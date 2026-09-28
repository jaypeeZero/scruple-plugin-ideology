import { resolveDecisionOptions, resolveDiagnosticSeverity } from '@scruple/core'
import type {
  ChoiceQuestion,
  DecisionRuleOptions,
  Diagnostic,
  FunctionTarget,
  ParsedDocument,
  RuleCandidate,
  RuleFactory,
  SemanticRule
} from '@scruple/core'
import { boundedText } from '../bounded.ts'
import { topLevelFunctions } from '../functions.ts'
import { defaultTestFilePattern } from '../testFiles.ts'

export interface NoDecisionsByOmissionOptions extends DecisionRuleOptions {
  testFilePattern?: string
}

const defaultThreshold = { warning: 0.85, error: 0.95 }
const defaultMinConfidence = 0.7

const instructions =
  'Does this function leave a decision unmade: by silencing a type checker or linter without a reason, or by shipping a placeholder where behaviour was needed, so that the consequence is unknown?'

const criteria = {
  decision_left_by_omission:
    'A checker is silenced with no stated reason, a value is cast through `any` or `unknown` to make it compile, a `TODO`/`FIXME` or `not implemented` stands where the behaviour should be, or a `default` branch silently does nothing.',
  deliberate_with_stated_reason:
    'The suppression or escape carries a reason in the same statement, the placeholder is a documented stub behind a feature flag, or the `default` branch enforces exhaustiveness by throwing or returning `never`.',
  boundary_type_narrowing:
    'The cast narrows a value that has just crossed a boundary (parsed JSON, a framework `unknown`) and a runtime check on the same value precedes or follows it.',
  insufficient_context:
    'Whether the escape is deliberate cannot be judged from the function shown.'
}

const finding = 'decision_left_by_omission'
const message = 'Make this decision explicit: state the reason, implement the behaviour, or remove the escape.'

type EscapeKind = 'type' | 'lint' | 'deferred'

interface Escape {
  kind: EscapeKind
  source: string
}

interface OffsetEscape extends Escape {
  offset: number
}

const deferredMarkerPattern = /\b(TODO|FIXME|HACK|XXX)\b/
const typeMarkerPattern = /@ts-ignore|@ts-expect-error|@ts-nocheck/
const lintDisablePattern = /\b(eslint-disable|scruple-disable)\b/

// A non-null assertion reads as deliberate only when it follows something that
// could plausibly be absent: an identifier, a call's closing paren, or an
// index's closing bracket. `!isOrder(...)` is a boolean negation, not this.
const typeLinePatterns: RegExp[] = [
  /:\s*any\b/,
  /\bas\s+any\b/,
  /<any>/,
  /\bas\s+unknown\s+as\b/,
  /[\w)\]]!\.|[\w)\]]!\(/,
  typeMarkerPattern
]

// `default:` followed by nothing, `break`, or `return` on the same line means
// the branch silently does nothing; `default: {` opens a block and is excluded,
// since a block can still throw or return a real value below.
const deferredLinePatterns: RegExp[] = [
  deferredMarkerPattern,
  /throw new Error\(['"](not implemented|todo|tbd)/i,
  /default:\s*(break|return)?\s*$/
]

const hasNoStatedReason = (text: string): boolean => !text.includes('--')

const lineEscapeKind = (line: string): EscapeKind | null => {
  if (typeLinePatterns.some((pattern) => pattern.test(line))) return 'type'
  if (lintDisablePattern.test(line) && hasNoStatedReason(line)) return 'lint'
  if (deferredLinePatterns.some((pattern) => pattern.test(line))) return 'deferred'
  return null
}

const lineEscapes = (fn: FunctionTarget): OffsetEscape[] => {
  const escapes: OffsetEscape[] = []
  let offset = 0
  for (const rawLine of fn.source.split('\n')) {
    const line = rawLine.trim()
    if (line !== '') {
      const kind = lineEscapeKind(line)
      if (kind !== null) escapes.push({ kind, source: line, offset })
    }
    offset += rawLine.length + 1
  }
  return escapes
}

const commentEscapeKind = (value: string): EscapeKind | null => {
  if (typeMarkerPattern.test(value)) return 'type'
  if (lintDisablePattern.test(value) && hasNoStatedReason(value)) return 'lint'
  if (deferredMarkerPattern.test(value)) return 'deferred'
  return null
}

// `document.comments` is parser-provided and does not confuse a TODO or an
// `@ts-ignore` living inside a string literal with a real comment, so it is
// gathered alongside the line scan and merged with it below.
const commentEscapes = (document: ParsedDocument, fn: FunctionTarget): OffsetEscape[] =>
  document.comments
    .filter((comment) => comment.range.start >= fn.range.start && comment.range.end <= fn.range.end)
    .flatMap((comment) => {
      const kind = commentEscapeKind(comment.value)
      return kind === null
        ? []
        : [{ kind, source: comment.source.trim(), offset: comment.range.start - fn.range.start }]
    })

// The line scan and the comment scan can both see the same physical line (a
// `// TODO` line is a line and a comment at once), so the merged list is
// deduplicated by its exact text, keeping the first occurrence in source order.
const collectEscapes = (document: ParsedDocument, fn: FunctionTarget): Escape[] => {
  const combined = [...lineEscapes(fn), ...commentEscapes(document, fn)].sort((a, b) => a.offset - b.offset)

  const seen = new Set<string>()
  const escapes: Escape[] = []
  for (const escape of combined) {
    if (seen.has(escape.source)) continue
    seen.add(escape.source)
    escapes.push({ kind: escape.kind, source: escape.source })
  }
  return escapes
}

export const noDecisionsByOmission: RuleFactory<NoDecisionsByOmissionOptions> = (
  options = {}
): SemanticRule => {
  const { threshold, minConfidence } = resolveDecisionOptions(options, {
    threshold: defaultThreshold,
    minConfidence: defaultMinConfidence
  })
  const testFilePattern = new RegExp(options.testFilePattern ?? defaultTestFilePattern)

  return {
    description: 'Silenced checkers and deferred placeholders are still decisions; state the reason or implement the behaviour.',
    collect(document: ParsedDocument): RuleCandidate[] {
      if (testFilePattern.test(document.filename)) return []

      return topLevelFunctions(document).flatMap((fn) => {
        const escapes = collectEscapes(document, fn)
        if (escapes.length === 0) return []

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
              escapes: escapes.map((escape) => ({ kind: escape.kind, source: escape.source }))
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
