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
import { defaultInfrastructureImportPatterns, importBindings } from '../importBindings.ts'
import { matchesAny } from '../patterns.ts'
import { defaultTestFilePattern } from '../testFiles.ts'

export interface OutboundCallResilienceOptions extends DecisionRuleOptions {
  testFilePattern?: string
  outboundCallPatterns?: string[]
  resiliencePatterns?: string[]
}

const defaultThreshold = { warning: 0.85, error: 0.95 }
const defaultMinConfidence = 0.7
const infrastructureImportPatterns = defaultInfrastructureImportPatterns.map((pattern) => new RegExp(pattern))

const defaultOutboundCallPatterns = [
  '^(fetch|axios|got|ky|undici)\\b',
  '\\.(get|post|put|patch|delete|request|send|publish|query|execute|find\\w*|save|insert|update|connect|invoke|call)$',
  '^\\w+\\.(charges|customers|messages|objects|invoices)\\.'
]

const defaultResiliencePatterns = [
  '\\b(timeout|timeoutMs|signal|AbortSignal|AbortController|withTimeout|retry|retries|maxAttempts|backoff|circuit|fallback|deadline)\\b',
  'Promise\\.(race|any|allSettled)\\b',
  '\\.timeout\\('
]

const instructions =
  'Does this function call an external service without any design for that service being slow or down - no timeout, abort signal, retry policy, fallback, or circuit - so that a hung or failed dependency hangs or fails this function indefinitely?'

const criteria = {
  unguarded_outbound_call:
    'At least one awaited call to a network, database, queue, or third-party service has no timeout, abort signal, retry, fallback, or circuit visible here, and nothing in the function name or wrapper indicates the policy lives elsewhere.',
  resilience_present:
    'Every outbound call is covered by a timeout, signal, retry, fallback, or circuit in this body, or is made through a wrapper whose name states the policy.',
  resilience_owned_by_caller:
    'The function receives the client or a signal from its caller and is documented or shaped as a thin adapter whose caller owns the policy.',
  insufficient_context:
    'Whether the callee is an external service, or whether a policy wraps it elsewhere, cannot be determined from the function shown.'
}

const finding = 'unguarded_outbound_call'
const message = 'Give this external call a timeout, abort signal, or retry policy, or a fallback.'

const calleeRootPattern = /^[A-Za-z_$][\w$]*/

const calleeRoot = (callee: string): string => calleeRootPattern.exec(callee)?.[0] ?? callee

const isWithin = (
  inner: { start: number; end: number },
  outer: { start: number; end: number }
): boolean => inner.start >= outer.start && inner.end <= outer.end

// A structured call fact only marks the outermost awaited expression; a call nested
// inside it (`Promise.race([pool.query(...), timer])`, a call passed as an argument)
// is still waited on, so it counts as awaited when any awaited call's range encloses
// it. Without facts, the same idea is approximated from source text: a call counts
// when its own line also awaits.
const isAwaitedOrNestedInAwaited = (
  call: { awaited: boolean; range: { start: number; end: number } },
  awaitedRanges: { start: number; end: number }[]
): boolean => call.awaited || awaitedRanges.some((range) => isWithin(call.range, range))

const lineAwaitsCall = (source: string, callSource: string): boolean =>
  source.split('\n').some((line) => line.includes(callSource) && /\bawait\b/.test(line))

const outboundCallsFor = (
  fn: FunctionTarget,
  document: ParsedDocument,
  outboundCallPatterns: RegExp[],
  infrastructureBindingRoots: Set<string>
) => {
  const isOutbound = (callee: string): boolean =>
    matchesAny(outboundCallPatterns, callee) || infrastructureBindingRoots.has(calleeRoot(callee))

  const structuredCalls = document.facts?.calls
  const callsInFunction = structuredCalls?.filter((call) => isWithin(call.range, fn.range))
  const awaitedRanges = callsInFunction?.filter((call) => call.awaited).map((call) => call.range) ?? []
  const awaitedCalls = callsInFunction
    ? callsInFunction.filter((call) => isAwaitedOrNestedInAwaited(call, awaitedRanges))
    : fn.calls.filter((call) => lineAwaitsCall(fn.source, call.source))

  return awaitedCalls
    .filter((call) => isOutbound(call.callee ?? ''))
    .map((call) => ({ callee: call.callee ?? '', source: call.source, awaited: true }))
}

const resilienceLinesFor = (fn: FunctionTarget, resiliencePatterns: RegExp[]): string[] =>
  fn.source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => resiliencePatterns.some((pattern) => pattern.test(line)))

export const outboundCallResilience: RuleFactory<OutboundCallResilienceOptions> = (
  options = {}
): SemanticRule => {
  const { threshold, minConfidence } = resolveDecisionOptions(options, {
    threshold: defaultThreshold,
    minConfidence: defaultMinConfidence
  })
  const testFilePattern = new RegExp(options.testFilePattern ?? defaultTestFilePattern)
  const outboundCallPatterns = (options.outboundCallPatterns ?? defaultOutboundCallPatterns).map(
    (pattern) => new RegExp(pattern)
  )
  const resiliencePatterns = (options.resiliencePatterns ?? defaultResiliencePatterns).map(
    (pattern) => new RegExp(pattern)
  )

  return {
    description:
      'An awaited call to an external service needs a timeout, abort signal, retry policy, fallback, or circuit; failures from external services are the normal path, not edge cases.',
    collect(document: ParsedDocument): RuleCandidate[] {
      if (testFilePattern.test(document.filename)) return []

      const infrastructureBindingRoots = new Set(
        importBindings(document, infrastructureImportPatterns).flatMap((entry) => entry.bindings)
      )

      return topLevelFunctions(document).flatMap((fn) => {
        const outboundCalls = outboundCallsFor(fn, document, outboundCallPatterns, infrastructureBindingRoots)
        if (outboundCalls.length === 0) return []

        const resilience = resilienceLinesFor(fn, resiliencePatterns)

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
              outboundCalls,
              resilience
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
