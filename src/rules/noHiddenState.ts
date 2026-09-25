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

export interface NoHiddenStateOptions extends DecisionRuleOptions {
  testFilePattern?: string
}

const defaultThreshold = { warning: 0.85, error: 0.95 }
const defaultMinConfidence = 0.7

const instructions =
  'Does this function read or write module-level state that is not passed in as a parameter?'

const criteria = {
  reads_or_writes_hidden_state:
    'The function\'s result or effect depends on, or changes, a module-level variable or object that is not one of its parameters.',
  references_immutable_constant:
    'The module-level binding is a fixed value (constant, frozen config, regex, lookup table) and is only read.',
  insufficient_context:
    'The referenced binding\'s mutability or role cannot be determined from the function and declarations shown.'
}

const finding = 'reads_or_writes_hidden_state'
const message = 'Pass this state in as a parameter instead of reading or writing module scope.'

interface ModuleBinding {
  name: string
  line: string
}

// `StructuredDeclarationFact.kind` only reports `using`/`await-using` bindings; the
// parser has no fact for a module-level `let`/`const`. Module scope is therefore
// derived directly from the source: everything outside every function's range.
const moduleScopeSource = (document: ParsedDocument): string => {
  const ranges = [...document.functions].map((fn) => fn.range).sort((a, b) => a.start - b.start)

  let text = ''
  let cursor = 0
  for (const range of ranges) {
    text += document.source.slice(cursor, range.start)
    cursor = Math.max(cursor, range.end)
  }
  text += document.source.slice(cursor)

  return text
}

const moduleBindingPattern = /^\s*(?:export\s+)?(?:let|var|const)\s+(\w+)/

// Whether a binding is a fixed constant or mutable state is the model's call
// (`references_immutable_constant` vs. the finding), not the prefilter's, so every
// top-level `let`/`var`/`const` name is collected regardless of its initializer.
// A binding whose name is one of the document's own functions is a function, not state:
// its body is excised from module scope, leaving only `const name =` behind.
const moduleBindings = (document: ParsedDocument): ModuleBinding[] => {
  const functionNames = new Set(document.functions.map((fn) => fn.name))
  return moduleScopeSource(document)
    .split('\n')
    .flatMap((line) => {
      const match = moduleBindingPattern.exec(line)
      return match && !functionNames.has(match[1]) ? [{ name: match[1], line: line.trim() }] : []
    })
}

export const noHiddenState: RuleFactory<NoHiddenStateOptions> = (
  options = {}
): SemanticRule => {
  const { threshold, minConfidence } = resolveDecisionOptions(options, {
    threshold: defaultThreshold,
    minConfidence: defaultMinConfidence
  })
  const testFilePattern = new RegExp(options.testFilePattern ?? defaultTestFilePattern)

  return {
    description: 'Functions should receive state as parameters instead of reading or writing module scope.',
    collect(document: ParsedDocument): RuleCandidate[] {
      if (testFilePattern.test(document.filename)) return []

      const bindings = moduleBindings(document)
      if (bindings.length === 0) return []

      return topLevelFunctions(document).flatMap((fn) => {
        const referenced = bindings.filter((binding) =>
          new RegExp(`\\b${binding.name}\\b`).test(fn.source)
        )

        if (referenced.length === 0) return []

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
              moduleBindings: referenced.map((binding) => binding.line)
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
