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
import { loopRegionsWithin } from '../loopRegions.ts'
import { stripStringLiterals } from '../stringLiterals.ts'
import { defaultTestFilePattern } from '../testFiles.ts'

export interface PreferCompositionOptions extends DecisionRuleOptions {
  testFilePattern?: string
  minSteps?: number
  minNesting?: number
  minChain?: number
}

const defaultThreshold = { warning: 0.85, error: 0.95 }
const defaultMinConfidence = 0.7
const defaultMinSteps = 3
const defaultMinNesting = 4
const defaultMinChain = 5

const instructions =
  'Does this function inline a sequence of separate transformations that would each be clearer as a small named function composed together?'

const criteria = {
  inlines_composable_steps:
    'Three or more distinct transformations are applied in sequence to one working value inside this body; each has a nameable purpose and could stand alone; the body reads as a recipe rather than a composition.',
  steps_are_one_transformation:
    'The steps are facets of a single transformation (building one object\'s fields, one arithmetic formula) and naming them separately would add indirection without meaning.',
  already_composed:
    'Each step is already a call to a named function or method with an intent-revealing name; the chain is the composition.',
  insufficient_context:
    'Whether the steps are independently meaningful cannot be judged from the function shown.'
}

const finding = 'inlines_composable_steps'
const message = 'Extract each transformation into a named function and compose them.'

type EvidenceKind = 'reassignment' | 'pyramid' | 'method-chain'

interface Evidence {
  kind: EvidenceKind
  steps: number
  source: string
}

const nonBlankLines = (source: string): string[] =>
  source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')

const referencesName = (expr: string, name: string): boolean => new RegExp(`\\b${name}\\b`).test(expr)

const letDeclarationPattern = /^let\s+(\w+)\s*=/
const reassignmentPattern = /^(\w+)\s*=(?!=)\s*(.+)$/

// A `let x = ...` immediately followed by lines that each reassign `x` from an
// expression containing `x` itself is the imperative shape of a pipeline: the
// value moves forward one step at a time under one name. Only strictly
// consecutive reassignments count, since a statement in between means the
// value stopped moving and something else happened.
const letReassignmentChains = (fn: { source: string }, minSteps: number): Evidence[] => {
  const lines = nonBlankLines(fn.source).map((line) => stripStringLiterals(line))
  const evidence: Evidence[] = []

  for (let i = 0; i < lines.length; i++) {
    const letMatch = letDeclarationPattern.exec(lines[i])
    if (!letMatch) continue

    const name = letMatch[1]
    let reassignCount = 0
    let j = i + 1
    while (j < lines.length) {
      const match = reassignmentPattern.exec(lines[j])
      if (!match || match[1] !== name || !referencesName(match[2], name)) break
      reassignCount++
      j++
    }

    if (reassignCount >= minSteps - 1) {
      evidence.push({ kind: 'reassignment', steps: reassignCount + 1, source: lines.slice(i, j).join('; ') })
    }
  }

  return evidence
}

const constDeclarationPattern = /^(?:export\s+)?const\s+(\w+)\s*=\s*(.+)$/

// A run of `const` declarations where each initializer references the binding
// immediately before it is the declarative shape of the same pipeline: each
// step gets its own name, but every name after the first is used exactly once,
// by the very next line. A `const` whose initializer does not reach back to
// the previous binding starts a fresh chain instead of continuing this one.
const constReassignmentChains = (fn: { source: string }, minSteps: number): Evidence[] => {
  const lines = nonBlankLines(fn.source).map((line) => stripStringLiterals(line))
  const evidence: Evidence[] = []

  let chainStart = 0
  let chainLength = 0
  let previousName: string | undefined

  const flushChain = (endExclusive: number): void => {
    if (chainLength >= minSteps) {
      evidence.push({
        kind: 'reassignment',
        steps: chainLength,
        source: lines.slice(chainStart, endExclusive).join('; ')
      })
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const match = constDeclarationPattern.exec(lines[i])
    if (!match) {
      flushChain(i)
      chainLength = 0
      previousName = undefined
      continue
    }

    const name = match[1]
    const initializer = match[2]
    if (previousName !== undefined && referencesName(initializer, previousName)) {
      chainLength++
    } else {
      flushChain(i)
      chainStart = i
      chainLength = 1
    }
    previousName = name
  }
  flushChain(lines.length)

  return evidence
}

// Depth of unmatched `(` reached at any point in the line, counting only real
// parentheses. A flat call with several arguments never climbs past depth one;
// only calls nested directly inside one another's argument list, `f(g(h(x)))`,
// climb to the depth that names a pyramid.
const maxParenDepth = (line: string): number => {
  let depth = 0
  let max = 0
  for (const char of line) {
    if (char === '(') {
      depth++
      max = Math.max(max, depth)
    } else if (char === ')') {
      depth = Math.max(depth - 1, 0)
    }
  }
  return max
}

const callPyramids = (fn: { source: string }, minNesting: number): Evidence[] => {
  const evidence: Evidence[] = []
  for (const rawLine of fn.source.split('\n')) {
    const line = rawLine.trim()
    if (line === '') continue

    const depth = maxParenDepth(stripStringLiterals(line))
    if (depth >= minNesting) {
      evidence.push({ kind: 'pyramid', steps: depth, source: line })
    }
  }
  return evidence
}

interface CallSpan {
  start: number
  end: number
}

const dotCallPattern = /\.\w+\(/g

// Every `.name(` call site, paired with the index of its own matching close
// paren via a depth counter, since a call's argument list can itself contain
// any number of nested parens before that call ends.
const dotCalls = (source: string): CallSpan[] => {
  const calls: CallSpan[] = []
  for (const match of source.matchAll(dotCallPattern)) {
    const openIndex = match.index + match[0].length - 1
    let depth = 1
    let end = -1
    for (let i = openIndex + 1; i < source.length; i++) {
      if (source[i] === '(') depth++
      else if (source[i] === ')') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end !== -1) calls.push({ start: match.index, end })
  }
  return calls
}

const isNestedWithin = (call: CallSpan, other: CallSpan): boolean =>
  call !== other && other.start < call.start && call.end < other.end

// A call that sits entirely inside another call's argument list is a step in
// that call's argument, not a link in the chain the outer call belongs to; only
// the calls that are not nested inside any other call can be chain links.
const topLevelCalls = (calls: CallSpan[]): CallSpan[] =>
  calls.filter((call) => !calls.some((other) => isNestedWithin(call, other)))

const isAdjacent = (source: string, previousEnd: number, nextStart: number): boolean =>
  nextStart > previousEnd && /^\s*$/.test(source.slice(previousEnd + 1, nextStart))

const identifierStart = (source: string, index: number): number => {
  let start = index
  while (start > 0 && /[\w$]/.test(source[start - 1])) start--
  return start
}

// Calls chain when nothing but whitespace (a line break, indentation) sits
// between one call's close paren and the next call's leading dot; anything
// else - an intervening statement, an operator - means the calls are not one
// fluent expression.
const methodChains = (fn: { source: string }, minChain: number): Evidence[] => {
  const stripped = stripStringLiterals(fn.source)
  const calls = topLevelCalls(dotCalls(stripped)).sort((a, b) => a.start - b.start)
  const evidence: Evidence[] = []

  let chainStartIndex = 0
  let chainLength = 0

  const flush = (endIndex: number): void => {
    if (chainLength >= minChain) {
      const receiverStart = identifierStart(fn.source, chainStartIndex)
      evidence.push({
        kind: 'method-chain',
        steps: chainLength,
        source: fn.source.slice(receiverStart, endIndex + 1).trim()
      })
    }
  }

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]
    if (i === 0 || !isAdjacent(stripped, calls[i - 1].end, call.start)) {
      flush(calls[i - 1]?.end ?? -1)
      chainStartIndex = call.start
      chainLength = 1
    } else {
      chainLength++
    }
  }
  flush(calls[calls.length - 1]?.end ?? -1)

  return evidence
}

export const preferComposition: RuleFactory<PreferCompositionOptions> = (
  options = {}
): SemanticRule => {
  const { threshold, minConfidence } = resolveDecisionOptions(options, {
    threshold: defaultThreshold,
    minConfidence: defaultMinConfidence
  })
  const testFilePattern = new RegExp(options.testFilePattern ?? defaultTestFilePattern)
  const minSteps = options.minSteps ?? defaultMinSteps
  const minNesting = options.minNesting ?? defaultMinNesting
  const minChain = options.minChain ?? defaultMinChain

  return {
    description: 'Compose small, named transformations instead of inlining a sequence of steps in one body.',
    collect(document: ParsedDocument): RuleCandidate[] {
      if (testFilePattern.test(document.filename)) return []

      return topLevelFunctions(document).flatMap((fn) => {
        if (loopRegionsWithin(document, fn).length > 0) return []

        const chains: Evidence[] = [
          ...letReassignmentChains(fn, minSteps),
          ...constReassignmentChains(fn, minSteps),
          ...callPyramids(fn, minNesting),
          ...methodChains(fn, minChain)
        ]

        if (chains.length === 0) return []

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
              chains: chains.map((chain) => ({ kind: chain.kind, steps: chain.steps, source: chain.source }))
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
