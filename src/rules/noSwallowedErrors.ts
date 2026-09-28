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
import { defaultTestFilePattern } from '../testFiles.ts'

export interface NoSwallowedErrorsOptions extends DecisionRuleOptions {
  testFilePattern?: string
}

const defaultThreshold = { warning: 0.85, error: 0.95 }
const defaultMinConfidence = 0.7

const instructions =
  'Does this catch block stop an error from reaching the layer that should handle it, without enabling the surrounding code to continue correctly?'

const criteria = {
  swallows_or_masks_error:
    'The handler drops the error, logs and rethrows it unchanged, or replaces it with a default such as null, undefined, an empty collection, or false, so that the caller cannot distinguish the failure from a normal result.',
  recovers_and_continues:
    'After the catch, the surrounding code can still run correctly: the failure is recorded per item and processing continues, a documented fallback is applied, or the error is translated into a richer error and rethrown.',
  handles_at_entry_point:
    'The enclosing function is where errors become responses: an HTTP route handler, CLI command, message consumer, job runner, or `main`.',
  cleanup_only: 'The block\'s only job is releasing a resource; the error still propagates.',
  insufficient_context:
    'The enclosing function\'s role or the caller\'s expectations cannot be determined from the source shown.'
}

const finding = 'swallows_or_masks_error'
const message = 'Let this error propagate, or recover so the surrounding code can continue.'

export const noSwallowedErrors: RuleFactory<NoSwallowedErrorsOptions> = (
  options = {}
): SemanticRule => {
  const { threshold, minConfidence } = resolveDecisionOptions(options, {
    threshold: defaultThreshold,
    minConfidence: defaultMinConfidence
  })
  const testFilePattern = new RegExp(options.testFilePattern ?? defaultTestFilePattern)

  return {
    description: 'Error handlers should let errors propagate or recover so the surrounding code can continue.',
    collect(document: ParsedDocument): RuleCandidate[] {
      if (testFilePattern.test(document.filename)) return []

      const apiBoundaries = document.apiBoundaries ?? []

      return document.errorHandlers.map((handler) => {
        const question: ChoiceQuestion = {
          type: 'choice',
          instructions,
          criteria
        }

        const isApiBoundary = apiBoundaries.some(
          (boundary) =>
            handler.range.start >= boundary.handlerRange.start && handler.range.end <= boundary.handlerRange.end
        )

        const { text: handlerText, truncated: handlerTruncated } = boundedText(handler.bodySource, 2000)
        const { text: triedText, truncated: triedTruncated } = boundedText(handler.trySource, 2000)
        const { text: enclosingText, truncated: enclosingTruncated } = boundedText(handler.enclosingSource ?? '', 3000)

        return {
          target: handler,
          state: {
            language: handler.language,
            handler: { text: handlerText, truncated: handlerTruncated },
            tried: { text: triedText, truncated: triedTruncated },
            binding: handler.binding ?? null,
            exits: handler.exits.map((exit) => ({ kind: exit.kind, source: exit.source })),
            calls: handler.calls.map((call) => call.callee),
            enclosing: { text: enclosingText, truncated: enclosingTruncated },
            isApiBoundary
          },
          question
        }
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
