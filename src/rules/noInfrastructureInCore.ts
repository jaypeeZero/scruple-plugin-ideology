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
import { defaultCompositionRootPattern } from '../compositionRoot.ts'
import { topLevelFunctions } from '../functions.ts'
import { defaultInfrastructureImportPatterns, importBindings } from '../importBindings.ts'
import { stripStringLiterals } from '../stringLiterals.ts'
import { defaultTestFilePattern } from '../testFiles.ts'

export interface NoInfrastructureInCoreOptions extends DecisionRuleOptions {
  testFilePattern?: string
  compositionRootPattern?: string
  infrastructureImportPatterns?: string[]
}

const defaultThreshold = { warning: 0.85, error: 0.95 }
const defaultMinConfidence = 0.7

const instructions =
  'Is this function core business logic that reaches directly into an infrastructure package, rather than an edge adapter whose only job is to translate between that infrastructure and the domain?'

const criteria = {
  core_depends_on_infrastructure:
    'The function decides business rules (pricing, eligibility, state transitions, selection among domain entities) and, in the same body, calls into or passes around an imported infrastructure client, driver, SDK, or framework object.',
  edge_adapter:
    'The function\'s whole job is to speak to the infrastructure and hand back or accept domain values: a repository method, an HTTP client wrapper, a route handler that delegates to a service. Mapping fields and throwing on missing rows are part of adapting.',
  infrastructure_type_only:
    'The imported binding is used only as a type annotation or is received as an already-constructed parameter typed by an interface the core owns.',
  insufficient_context:
    'Whether the referenced logic is a business rule or a translation cannot be judged from the function shown.'
}

const finding = 'core_depends_on_infrastructure'
const message = 'Move this business rule into the core and reach the infrastructure through an injected edge.'

const ifOrSwitchPattern = /\b(?:if|switch)\s*\(/
// A genuine ternary has whitespace around its `?`, distinguishing it from an
// optional property or parameter marker (`cc?: string`), which never does.
const ternaryPattern = /\s\?\s[^:]*:\s/
const arithmeticOrComparisonPattern = /([A-Za-z_$][\w$]*)\s*(<=|>=|===|!==|<|>|[*/%+-])\s*([A-Za-z_$][\w$]*)/g

// An operator line only counts when neither operand is one of the infrastructure
// bindings this function references; an expression built entirely from domain
// identifiers is what marks a line as a business rule rather than plumbing. A
// single-argument generic (`Promise<number>`, `Array<string>`) shares `identifier
// < identifier` with a real comparison; it is told apart by the `>` that closes
// the generic immediately after the second identifier, which a comparison never has.
const hasNonInfrastructureOperatorSignal = (line: string, infrastructureBindings: Set<string>): boolean => {
  for (const match of line.matchAll(arithmeticOrComparisonPattern)) {
    const isGenericTypeArgument = match[2] === '<' && line[(match.index ?? 0) + match[0].length] === '>'
    if (isGenericTypeArgument) continue
    if (!infrastructureBindings.has(match[1]) && !infrastructureBindings.has(match[3])) return true
  }
  return false
}

const ruleSignalsFor = (fn: FunctionTarget, infrastructureBindings: string[]): string[] => {
  const bindingSet = new Set(infrastructureBindings)

  return fn.source.split('\n').flatMap((line) => {
    const stripped = stripStringLiterals(line)
    const isSignal =
      ifOrSwitchPattern.test(stripped) ||
      ternaryPattern.test(stripped) ||
      hasNonInfrastructureOperatorSignal(stripped, bindingSet)
    return isSignal ? [line.trim()] : []
  })
}

export const noInfrastructureInCore: RuleFactory<NoInfrastructureInCoreOptions> = (
  options = {}
): SemanticRule => {
  const { threshold, minConfidence } = resolveDecisionOptions(options, {
    threshold: defaultThreshold,
    minConfidence: defaultMinConfidence
  })
  const testFilePattern = new RegExp(options.testFilePattern ?? defaultTestFilePattern)
  const compositionRootPattern = new RegExp(
    options.compositionRootPattern ?? defaultCompositionRootPattern
  )
  const infrastructureImportPatterns = (
    options.infrastructureImportPatterns ?? defaultInfrastructureImportPatterns
  ).map((pattern) => new RegExp(pattern))

  return {
    description:
      'Business logic should stay free of infrastructure; a function that decides a business rule should not also reach into an imported infrastructure client.',
    collect(document: ParsedDocument): RuleCandidate[] {
      if (testFilePattern.test(document.filename)) return []
      if (compositionRootPattern.test(document.filename)) return []

      const infrastructureBindingEntries = importBindings(document, infrastructureImportPatterns)
      const infraImports = infrastructureBindingEntries.map((entry) => entry.specifier)
      if (infraImports.length === 0) return []

      const allBindingNames = infrastructureBindingEntries.flatMap((entry) => entry.bindings)

      return topLevelFunctions(document).flatMap((fn) => {
        const infrastructureBindings = allBindingNames.filter((name) =>
          new RegExp(`\\b${name}\\b`).test(fn.source)
        )
        if (infrastructureBindings.length === 0) return []

        const ruleSignals = ruleSignalsFor(fn, infrastructureBindings)
        if (ruleSignals.length === 0) return []

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
              infrastructureImports: infraImports,
              function: { text, truncated },
              infrastructureBindings,
              ruleSignals
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
