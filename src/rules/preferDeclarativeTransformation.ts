import { resolveDecisionOptions, resolveDiagnosticSeverity } from '@scruple/core'
import type {
  ChoiceQuestion,
  ControlRegionFact,
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

export interface PreferDeclarativeTransformationOptions extends DecisionRuleOptions {
  testFilePattern?: string
  effectCallPatterns?: string[]
}

const defaultThreshold = { warning: 0.85, error: 0.95 }
const defaultMinConfidence = 0.7
const defaultEffectCallPatterns = ['\\.forEach$']

const instructions =
  'Does this loop build a value step by step that a single map, filter, reduce, find, some/every, flatMap, or Object.fromEntries would express directly?'

const criteria = {
  loop_is_disguised_transformation:
    'The loop\'s body accumulates into a collection, object, or scalar declared before the loop (push, index assignment, +=, [key] = value) with no early exit, and the same result is one map, filter, reduce, find, some, every, flatMap, or Object.fromEntries call.',
  loop_performs_effects:
    'The body\'s purpose is to perform an effect per element (register, write, send, log, await a call) rather than to produce a value.',
  loop_needs_imperative_control:
    'The body uses break, continue, early return, index arithmetic across elements, or awaits in a fixed order where the sequencing matters, so no single collection method expresses it.',
  insufficient_context:
    'The body\'s purpose cannot be determined from the function shown.'
}

const finding = 'loop_is_disguised_transformation'
const message = 'Express this loop as a map, filter, reduce, or similar declarative transformation.'

interface LoopEvidence {
  kind: string
  source: string
}

const matchesAny = (patterns: RegExp[], value: string): boolean =>
  patterns.some((pattern) => pattern.test(value))

export const preferDeclarativeTransformation: RuleFactory<PreferDeclarativeTransformationOptions> = (
  options = {}
): SemanticRule => {
  const { threshold, minConfidence } = resolveDecisionOptions(options, {
    threshold: defaultThreshold,
    minConfidence: defaultMinConfidence
  })
  const testFilePattern = new RegExp(options.testFilePattern ?? defaultTestFilePattern)
  const effectCallPatterns = (options.effectCallPatterns ?? defaultEffectCallPatterns).map(
    (pattern) => new RegExp(pattern)
  )

  return {
    description: 'A loop that builds a value step by step should be expressed as a declarative transformation.',
    collect(document: ParsedDocument): RuleCandidate[] {
      if (testFilePattern.test(document.filename)) return []

      return topLevelFunctions(document).flatMap((fn) => {
        const loopRegions = (document.facts?.controls ?? []).filter(
          (control): control is ControlRegionFact & { kind: 'loop' } =>
            control.kind === 'loop' && control.range.start >= fn.range.start && control.range.end <= fn.range.end
        )
        const effectCalls = fn.calls.filter((call) => matchesAny(effectCallPatterns, call.callee))

        if (loopRegions.length === 0 && effectCalls.length === 0) return []

        const loops: LoopEvidence[] = [
          ...loopRegions.map((region) => ({
            kind: region.loop ?? 'loop',
            source: document.source.slice(region.range.start, region.range.end)
          })),
          ...effectCalls.map((call) => ({
            kind: 'forEach',
            source: call.source
          }))
        ]

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
              loops: loops.map((loop) => ({
                kind: loop.kind,
                source: boundedText(loop.source, 1500).text
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
