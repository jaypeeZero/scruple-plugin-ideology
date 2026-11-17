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
import { defaultMinConfidence, defaultThreshold } from '../decisionDefaults.ts'
import { boundedText } from '../bounded.ts'
import { declarationOf } from '../declaration.ts'
import { topLevelFunctions } from '../functions.ts'
import { defaultInfrastructureImportPatterns, importBindings } from '../importBindings.ts'
import { boundNames, parameterListText, splitTopLevelParams } from '../parameters.ts'
import { matchesAny } from '../patterns.ts'
import { defaultTestFilePattern } from '../testFiles.ts'

export interface OutboundCallResilienceOptions extends DecisionRuleOptions {
  testFilePattern?: string
  outboundCallPatterns?: string[]
  resiliencePatterns?: string[]
}

const infrastructureImportPatterns = defaultInfrastructureImportPatterns.map((pattern) => new RegExp(pattern))

// A call site is a candidate only when the call goes straight to the network. A call
// through a client the function was given (a pool, an SDK, an ORM table) carries
// whatever policy that client was built with, so it is judged where it is built.
const defaultOutboundCallPatterns = ['^(fetch|axios|got|ky|undici)\\b']

// A factory call builds a client when its root is a vendor binding (`axios.create`,
// a `createClient` imported from redis).
const clientFactoryCallPatterns = [/\.create$/, /^create[A-Z]/, /^connect$/]

const defaultResiliencePatterns = [
  '\\b(\\w*(timeout|Timeout|TIMEOUT)\\w*|signal|AbortSignal|AbortController|retry|retries|maxAttempts|backoff|circuit|fallback|deadline)\\b',
  'Promise\\.(race|any|allSettled)\\b',
  '\\.timeout\\('
]

const instructions =
  'Does this function leave calls to an external service with no design for that service being slow or down - no timeout, abort signal, retry policy, fallback, or circuit? For each client it builds (clientConstructions), the configuration it is built with is the policy for every call made through it. For each call it makes straight to the network with no client in between (outboundCalls), the policy is at the call.'

const criteria = {
  unguarded_outbound_call:
    'A client, connection, or pool built here for a network, database, queue, or third-party service is configured with no request, statement, or query timeout, deadline, or retry policy, so calls made through it can wait forever; a timeout on acquiring or opening a connection bounds only getting the connection, not the calls made on it. Or a call made straight to the network has no timeout, abort signal, retry, fallback, or circuit, and nothing in the function name, a wrapper, or the declaration.docComment says the policy lives elsewhere.',
  resilience_present:
    'Every client built here is configured with a request, statement, or query timeout, deadline, or retry policy for the calls made through it, and every call made straight to the network has a timeout, signal, retry, fallback, or circuit in this body (a retry wrapper around it, a catch that falls back to another value), or goes through a wrapper whose name states the policy.',
  resilience_owned_by_caller:
    'The caller passes the policy in: the function receives an abort signal, timeout, or deadline and hands it to its outbound calls or to the client it builds, or the declaration.docComment states that the caller owns the timeout and retry policy.',
  insufficient_context:
    'Whether what is built or called is an external service, or whether its configuration bounds calls, cannot be determined from the function shown.'
}

const finding = 'unguarded_outbound_call'
const message = 'Bound the calls to this external service: give the client a timeout or deadline where it is built, or give this direct call a timeout, abort signal, retry policy, or fallback.'

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

const clientConstructionsFor = (
  fn: FunctionTarget,
  document: ParsedDocument,
  infrastructureBindingRoots: Set<string>
): string[] => {
  const parameters = new Set(splitTopLevelParams(parameterListText(fn.source)).flatMap(boundNames))
  const isVendorBinding = (callee: string): boolean => infrastructureBindingRoots.has(calleeRoot(callee))

  // A parameter only counts behind `new`: calling `.create` on a client the function
  // was given makes a record, not a client.
  const constructors = (document.facts?.constructors ?? [])
    .filter((ctor) => isWithin(ctor.range, fn.range))
    .filter((ctor) => isVendorBinding(ctor.callee ?? '') || parameters.has(ctor.callee ?? ''))
    .map((ctor) => ctor.source)
  const factoryCalls = fn.calls
    .filter((call) => matchesAny(clientFactoryCallPatterns, call.callee) && isVendorBinding(call.callee))
    .map((call) => call.source)

  return [...constructors, ...factoryCalls]
}

const resilienceLinesFor =(fn: FunctionTarget, resiliencePatterns: RegExp[]): string[] =>
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
      'Every call to an external service is bounded, by the client it goes through where that client is built, or at the call when it goes straight to the network; failures from external services are the normal path, not edge cases.',
    collect(document: ParsedDocument): RuleCandidate[] {
      if (testFilePattern.test(document.filename)) return []

      const infrastructureBindingRoots = new Set(
        importBindings(document, infrastructureImportPatterns).flatMap((entry) => entry.bindings)
      )

      return topLevelFunctions(document).flatMap((fn) => {
        const outboundCalls = outboundCallsFor(fn, document, outboundCallPatterns, infrastructureBindingRoots)
        const clientConstructions = clientConstructionsFor(fn, document, infrastructureBindingRoots)
        if (outboundCalls.length === 0 && clientConstructions.length === 0) return []

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
              declaration: declarationOf(document, fn),
              outboundCalls,
              clientConstructions,
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
