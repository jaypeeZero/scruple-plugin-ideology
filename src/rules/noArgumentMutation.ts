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
import { parameterListText } from '../parameters.ts'
import { defaultTestFilePattern } from '../testFiles.ts'

export interface NoArgumentMutationOptions extends DecisionRuleOptions {
  testFilePattern?: string
  mutatingMethodPatterns?: string[]
}

const defaultThreshold = { warning: 0.85, error: 0.95 }
const defaultMinConfidence = 0.7
const defaultMutatingMethodPatterns = ['^(push|pop|shift|unshift|splice|sort|reverse|fill|copyWithin|set|delete|clear|add)$']

const instructions =
  'Does this function change the contents of a value it received as a parameter, so that the caller\'s copy is different after the call?'

const criteria = {
  mutates_parameter:
    'A property, element, or entry of a parameter, or of something reached through a parameter, is assigned, deleted, or changed by a mutating method, and that change is visible to the caller after the function returns.',
  mutates_local_copy:
    'The mutation targets a value this function created (spread, slice, `new`, structuredClone, Array.from, a fresh literal); the parameter itself is unchanged.',
  parameter_is_a_builder_by_contract:
    'The parameter is an accumulator, sink, or builder that the caller passed in specifically to be filled (a reduce accumulator, a stream, a response object, a Set being populated), and filling it is the function\'s documented job.',
  insufficient_context:
    'Whether the mutated binding aliases the parameter cannot be determined from the function shown.'
}

const finding = 'mutates_parameter'
const message = 'Return a new value instead of mutating this parameter.'

// Splits a parameter list (or a destructuring pattern's inner text) on its
// top-level commas, tracking bracket depth so a nested object, array, or
// default-value literal never breaks a single parameter in two.
const splitTopLevelParams = (text: string): string[] => {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of text) {
    if (char === '(' || char === '[' || char === '{') depth++
    else if (char === ')' || char === ']' || char === '}') depth--

    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim() !== '') parts.push(current)
  return parts
}

// A destructured parameter contributes every bound identifier: the shorthand
// name (`{ a }`), the rename target rather than the object key (`{ a: b }`
// binds `b`, not `a`), array elements, and rest elements, recursively.
const boundNames = (segment: string): string[] => {
  const trimmed = segment.trim()

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const isObject = trimmed.startsWith('{')
    const closeIndex = trimmed.lastIndexOf(isObject ? '}' : ']')
    const inner = trimmed.slice(1, closeIndex === -1 ? trimmed.length : closeIndex)

    return splitTopLevelParams(inner).flatMap((part) => {
      const piece = part.split('=')[0]?.trim() ?? ''
      if (piece === '') return []
      if (piece.startsWith('...')) return boundNames(piece.slice(3))
      if (isObject) {
        const colonIndex = piece.indexOf(':')
        return boundNames(colonIndex === -1 ? piece : piece.slice(colonIndex + 1))
      }
      return boundNames(piece)
    })
  }

  const match = /^\.\.\.\s*([A-Za-z_$][\w$]*)|^([A-Za-z_$][\w$]*)/.exec(trimmed)
  const name = match ? match[1] ?? match[2] : undefined
  return name ? [name] : []
}

const parameterNames = (source: string): string[] =>
  splitTopLevelParams(parameterListText(source)).flatMap(boundNames)

const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A parameter's own binding, plus one or more member/index accesses reached
// through it (`p.x`, `p[k]`, `p.x.y`); reassigning the bare binding (`p = …`)
// never matches this suffix, which is deliberate: that is rebinding, not mutation.
const memberOrIndexSuffix = '(?:\\??\\.[\\w$]+|\\[[^\\]\\n]+\\])+'

const assignmentPattern = (param: string): RegExp =>
  new RegExp(
    `\\b${escapeForRegExp(param)}${memberOrIndexSuffix}\\s*(?:=(?!=)|\\+=|-=|\\*=|/=|%=|\\*\\*=|&&=|\\|\\|=|\\?\\?=)`
  )

const incrementPattern = (param: string): RegExp =>
  new RegExp(
    `(?:\\b${escapeForRegExp(param)}${memberOrIndexSuffix}\\s*(?:\\+\\+|--))|(?:(?:\\+\\+|--)\\s*${escapeForRegExp(param)}${memberOrIndexSuffix})`
  )

const deletePattern = (param: string): RegExp =>
  new RegExp(`\\bdelete\\s+${escapeForRegExp(param)}${memberOrIndexSuffix}`)

interface MutationEvidence {
  start: number
  text: string
}

const lineEvidence = (fn: FunctionTarget, parameters: string[]): MutationEvidence[] => {
  const patterns = parameters.flatMap((param) => [
    assignmentPattern(param),
    incrementPattern(param),
    deletePattern(param)
  ])

  const evidence: MutationEvidence[] = []
  let offset = 0
  for (const line of fn.source.split('\n')) {
    if (patterns.some((pattern) => pattern.test(line))) {
      evidence.push({ start: offset, text: line.trim() })
    }
    offset += line.length + 1
  }
  return evidence
}

// `p?.push()` normalizes to `p.push` before reading the root identifier and
// the final method name, so optional chaining does not hide a mutating call.
const calleeRoot = (callee: string): string => {
  const match = /^([A-Za-z_$][\w$]*)/.exec(callee.replace(/\?\./g, '.'))
  return match ? match[1] : ''
}

const calleeMethod = (callee: string): string => {
  const parts = callee.replace(/\?\./g, '.').split('.')
  return parts[parts.length - 1] ?? ''
}

const methodCallEvidence = (
  fn: FunctionTarget,
  parameters: Set<string>,
  mutatingMethodPatterns: RegExp[]
): MutationEvidence[] =>
  fn.calls
    .filter(
      (call) =>
        parameters.has(calleeRoot(call.callee)) &&
        mutatingMethodPatterns.some((pattern) => pattern.test(calleeMethod(call.callee)))
    )
    .map((call) => ({ start: call.range.start - fn.range.start, text: call.source.trim() }))

const mutationEvidence = (
  fn: FunctionTarget,
  parameters: string[],
  mutatingMethodPatterns: RegExp[]
): string[] => {
  const evidence = [
    ...lineEvidence(fn, parameters),
    ...methodCallEvidence(fn, new Set(parameters), mutatingMethodPatterns)
  ].sort((a, b) => a.start - b.start)

  const seen = new Set<string>()
  return evidence.flatMap(({ start, text }) => {
    const key = `${start}:${text}`
    if (seen.has(key)) return []
    seen.add(key)
    return [text]
  })
}

export const noArgumentMutation: RuleFactory<NoArgumentMutationOptions> = (
  options = {}
): SemanticRule => {
  const { threshold, minConfidence } = resolveDecisionOptions(options, {
    threshold: defaultThreshold,
    minConfidence: defaultMinConfidence
  })
  const testFilePattern = new RegExp(options.testFilePattern ?? defaultTestFilePattern)
  const mutatingMethodPatterns = (options.mutatingMethodPatterns ?? defaultMutatingMethodPatterns).map(
    (pattern) => new RegExp(pattern)
  )

  return {
    description: 'Functions should return a new value instead of mutating a parameter they received.',
    collect(document: ParsedDocument): RuleCandidate[] {
      if (testFilePattern.test(document.filename)) return []

      return topLevelFunctions(document).flatMap((fn) => {
        const parameters = parameterNames(fn.source)
        if (parameters.length === 0) return []

        const mutations = mutationEvidence(fn, parameters, mutatingMethodPatterns)
        if (mutations.length === 0) return []

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
              parameters,
              mutations
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
