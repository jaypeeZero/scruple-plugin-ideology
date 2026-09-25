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

export interface InjectDependenciesOptions extends DecisionRuleOptions {
  compositionRootPattern?: string
  testFilePattern?: string
  factoryCallPatterns?: string[]
}

const defaultThreshold = { warning: 0.85, error: 0.95 }
const defaultMinConfidence = 0.7
const defaultCompositionRootPattern = '(^|/)index\\.[cm]?[jt]sx?$'
const defaultFactoryCallPatterns = ['\\.create$', '^create[A-Z]', '^make[A-Z]', '^connect$']

const instructions =
  'Does this function build a collaborator it then uses, instead of receiving it as a parameter?'

const criteria = {
  constructs_collaborator_internally:
    'A client, repository, service, connection, or other object with behaviour is constructed here and used by this function or stored for later use.',
  constructs_plain_value:
    'Only data is constructed: built-in language or platform types, errors, dates, collections, DTOs, value objects, framework option bags.',
  returns_constructed_object:
    'The construction is the function\'s product and is returned or passed out; the function is itself a factory.',
  insufficient_context:
    'The imports and function body do not establish what the constructed thing is.'
}

const finding = 'constructs_collaborator_internally'
const message = 'Receive this collaborator as a parameter instead of constructing it here.'

export const injectDependencies: RuleFactory<InjectDependenciesOptions> = (
  options = {}
): SemanticRule => {
  const { threshold, minConfidence } = resolveDecisionOptions(options, {
    threshold: defaultThreshold,
    minConfidence: defaultMinConfidence
  })
  const compositionRootPattern = new RegExp(
    options.compositionRootPattern ?? defaultCompositionRootPattern
  )
  const testFilePattern = new RegExp(options.testFilePattern ?? defaultTestFilePattern)
  const factoryCallPatterns = (options.factoryCallPatterns ?? defaultFactoryCallPatterns).map(
    (pattern) => new RegExp(pattern)
  )

  return {
    description: 'Collaborators should be received as parameters, not constructed internally.',
    collect(document: ParsedDocument): RuleCandidate[] {
      if (compositionRootPattern.test(document.filename)) return []
      if (testFilePattern.test(document.filename)) return []

      const constructors = document.facts?.constructors ?? []

      return topLevelFunctions(document).flatMap((fn) => {
        const scopedConstructors = constructors.filter(
          (ctor) => ctor.range.start >= fn.range.start && ctor.range.end <= fn.range.end
        )
        const factoryCalls = fn.calls.filter((call) =>
          factoryCallPatterns.some((pattern) => pattern.test(call.callee))
        )

        if (scopedConstructors.length === 0 && factoryCalls.length === 0) return []

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
              constructions: [
                ...scopedConstructors.map((ctor) => ctor.source),
                ...factoryCalls.map((call) => call.source)
              ]
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
