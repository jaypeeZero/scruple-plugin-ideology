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
import { parameterListText, splitTopLevelParams } from '../parameters.ts'
import { defaultTestFilePattern } from '../testFiles.ts'

export interface NoVendorTypesInCoreOptions extends DecisionRuleOptions {
  testFilePattern?: string
  compositionRootPattern?: string
  infrastructureImportPatterns?: string[]
}

const defaultThreshold = { warning: 0.85, error: 0.95 }
const defaultMinConfidence = 0.7

const instructions =
  'Does this function expose a vendor or infrastructure package\'s own types or response shapes to its callers, so that swapping the service would change the callers too?'

const criteria = {
  vendor_shape_leaks_to_callers:
    'A parameter or return type is a type from the infrastructure package, or the function returns the vendor client\'s response unmapped, so callers depend on that vendor.',
  adapter_owns_the_vendor:
    'The function is the one place that talks to this vendor and it accepts and returns domain values or interfaces the codebase owns; vendor types appear only inside the body or in private helpers.',
  vendor_type_is_the_domain:
    'The package is not really infrastructure for this codebase (a utility library, a schema library) or its type is deliberately the domain model by decision recorded in the file.',
  insufficient_context:
    'Whether the exposed type is vendor-owned or codebase-owned cannot be determined from the imports and function shown.'
}

const finding = 'vendor_shape_leaks_to_callers'
const message = 'Return a domain value here and keep the vendor\'s types inside the adapter.'

const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const mentionsAny = (text: string, names: string[]): boolean =>
  names.some((name) => new RegExp(`\\b${escapeForRegExp(name)}\\b`).test(text))

interface Signature {
  parameters: string[]
  returnType: string
}

// The return annotation is whatever sits between the parameter list's closing
// paren and the token that opens the body (`=>` for an arrow, `{` otherwise),
// minus its leading colon. A function with no annotation yields an empty string.
const signatureOf = (fn: FunctionTarget): Signature => {
  const parameterText = parameterListText(fn.source)
  const parameters = splitTopLevelParams(parameterText).map((segment) => segment.trim()).filter((segment) => segment !== '')

  const openParen = fn.source.indexOf('(')
  if (openParen === -1) return { parameters, returnType: '' }

  const afterParameters = fn.source.slice(openParen + 1 + parameterText.length + 1)
  const bodyStart = afterParameters.search(/=>|\{/)
  const annotation = bodyStart === -1 ? afterParameters : afterParameters.slice(0, bodyStart)
  const returnType = annotation.replace(/^\s*:\s*/, '').trim()

  return { parameters, returnType }
}

const simpleTypedParameterPattern = /^([A-Za-z_$][\w$]*)\s*\??\s*:\s*(.+)$/

// A parameter typed with a vendor binding is the adapter's injected collaborator
// when the body calls methods on it (`pool.query(`); it is a leaked vendor shape
// when the body only reads it (`res.data`). The two are told apart by whether the
// parameter name is ever used as a callee root.
const isInvoked = (name: string, source: string): boolean =>
  new RegExp(`\\b${escapeForRegExp(name)}(?:\\s*\\??\\.\\s*[\\w$]+)+\\s*\\(`).test(source)

const returnCallPattern = /^\s*return\s+(?:await\s+)?(?:new\s+)?([A-Za-z_$][\w$]*)(?:\s*\??\.\s*[\w$]+)*\s*\(/

interface Leaks {
  signatureLeaks: string[]
  returnLeaks: string[]
}

const leaksFor = (fn: FunctionTarget, bindings: string[]): Leaks => {
  const { parameters, returnType } = signatureOf(fn)

  const vendorTypedParameters: string[] = []
  const signatureLeaks: string[] = []

  for (const parameter of parameters) {
    const typed = simpleTypedParameterPattern.exec(parameter)
    if (typed && mentionsAny(typed[2], bindings)) {
      vendorTypedParameters.push(typed[1])
      if (!isInvoked(typed[1], fn.source)) signatureLeaks.push(parameter)
    } else if (mentionsAny(parameter, bindings)) {
      signatureLeaks.push(parameter)
    }
  }

  if (returnType !== '' && mentionsAny(returnType, bindings)) signatureLeaks.push(returnType)

  const vendorRoots = new Set([...bindings, ...vendorTypedParameters])
  const returnLeaks = fn.source.split('\n').flatMap((line) => {
    const match = returnCallPattern.exec(line)
    return match && vendorRoots.has(match[1]) ? [line.trim()] : []
  })

  return { signatureLeaks, returnLeaks }
}

export const noVendorTypesInCore: RuleFactory<NoVendorTypesInCoreOptions> = (
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
      'A function should accept and return domain values; a vendor package\'s types and response shapes stay inside the adapter that owns them.',
    collect(document: ParsedDocument): RuleCandidate[] {
      if (testFilePattern.test(document.filename)) return []
      if (compositionRootPattern.test(document.filename)) return []

      const infrastructureBindingEntries = importBindings(document, infrastructureImportPatterns)
      const infraImports = infrastructureBindingEntries.map((entry) => entry.specifier)
      if (infraImports.length === 0) return []

      const bindings = infrastructureBindingEntries.flatMap((entry) => entry.bindings)

      return topLevelFunctions(document).flatMap((fn) => {
        const { signatureLeaks, returnLeaks } = leaksFor(fn, bindings)
        if (signatureLeaks.length === 0 && returnLeaks.length === 0) return []

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
              signatureLeaks,
              returnLeaks
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
