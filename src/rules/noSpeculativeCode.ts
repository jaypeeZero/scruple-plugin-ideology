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
import { boundNames, parameterListText, splitTopLevelParams } from '../parameters.ts'
import { matchesAny } from '../patterns.ts'
import { defaultTestFilePattern } from '../testFiles.ts'

export interface NoSpeculativeCodeOptions extends DecisionRuleOptions {
  testFilePattern?: string
  optionsParameterPatterns?: string[]
}

const defaultThreshold = { warning: 0.85, error: 0.95 }
const defaultMinConfidence = 0.7
const defaultOptionsParameterPatterns = ['^(options|opts|config|settings|params)$']

const instructions =
  'Does this function carry flexibility that nothing here uses — options never read, a flag that splits it in two, a branch that cannot vary, a parameter that only passes through — so that deleting that flexibility would leave the behaviour intact?'

const criteria = {
  speculative_flexibility:
    'At least one listed item could be removed with no change to any behaviour visible in this file: unread option keys, a flag that should be two functions, a constant condition, a hook nobody calls.',
  flexibility_is_exercised:
    'Each listed item is genuinely used: the options are read, the pass-through parameter is the function\'s whole job (an adapter), the flag is set from real input, the generic constrains two positions.',
  public_api_surface_by_contract:
    'The function is an exported library entry point whose signature is a published contract; unused-here does not mean unused.',
  insufficient_context:
    'Whether callers outside this file use the flexibility cannot be determined.'
}

const finding = 'speculative_flexibility'
const message = 'Delete this flexibility until something needs it.'

type SpeculationKind =
  | 'unread-options'
  | 'pass-through'
  | 'flag-parameter'
  | 'literal-condition'
  | 'default-callback'
  | 'unused-generic'

interface Evidence {
  kind: SpeculationKind
  source: string
  position: number
}

interface Parameter {
  name?: string
  text: string
  destructured: boolean
}

const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// One entry per top-level parameter: its raw declared text (type annotation,
// default value, or destructured keys included) plus, for a simple binding,
// the single identifier it binds. A destructured parameter has no one name,
// so `name` is left undefined for it.
const parametersOf = (source: string): Parameter[] =>
  splitTopLevelParams(parameterListText(source)).map((segment) => {
    const trimmed = segment.trim()
    const destructured = trimmed.startsWith('{') || trimmed.startsWith('[')
    return { name: destructured ? undefined : boundNames(segment)[0], text: trimmed, destructured }
  })

// Finds where the parameter list ends (mirrors `parameterListText`'s own
// paren-matching) so "appears once in the body" never counts an occurrence
// still inside the signature itself.
const afterParameterList = (source: string): string => {
  const openParen = source.indexOf('(')
  const arrow = source.indexOf('=>')
  if (openParen === -1 || (arrow !== -1 && arrow < openParen)) {
    return arrow === -1 ? source : source.slice(arrow + 2)
  }

  let depth = 0
  for (let i = openParen; i < source.length; i++) {
    if (source[i] === '(') depth++
    else if (source[i] === ')') {
      depth--
      if (depth === 0) return source.slice(i + 1)
    }
  }
  return ''
}

// A TS inline object-literal type, e.g. `options: { cc?: string; bcc?: string }`.
// Only a flat (non-nested) literal is read; a nested one is a false negative,
// which this cheap text scan accepts.
const typeLiteralPattern = /:\s*\{([^{}]*)\}/

const typeLiteralKeys = (text: string): string[] | undefined => {
  const match = typeLiteralPattern.exec(text)
  if (!match) return undefined

  return match[1]
    .split(/[;,]/)
    .map((part) => part.split(':')[0]?.trim().replace(/\?$/, '') ?? '')
    .filter((key) => key !== '')
}

// A declared key is read as a member (`param.key`) for a named parameter, or as
// a bound identifier (`key`) for a parameter that destructures it directly.
const isKeyRead = (param: Parameter, key: string, source: string): boolean => {
  const pattern = param.destructured
    ? new RegExp(`\\b${escapeForRegExp(key)}\\b`)
    : new RegExp(`\\b${escapeForRegExp(param.name ?? '')}\\??\\.${escapeForRegExp(key)}\\b`)
  return pattern.test(source)
}

// A parameter is options-shaped by name (`options`, `opts`, ...) or by an inline
// object-literal type; either way, evidence fires when fewer than half its
// declared keys are read, or (with no keys derivable) when the body never
// reaches into it with a member access at all.
const unreadOptionsEvidence = (
  fn: FunctionTarget,
  parameters: Parameter[],
  optionsParameterPatterns: RegExp[]
): Evidence[] =>
  parameters.flatMap((param) => {
    const nameMatches = param.name !== undefined && matchesAny(optionsParameterPatterns, param.name)
    const keys = typeLiteralKeys(param.text)
    if (!nameMatches && keys === undefined) return []

    const position = fn.source.indexOf(param.text)
    const evidencePosition = position === -1 ? 0 : position

    if (keys !== undefined) {
      if (keys.length === 0) return []
      const readCount = keys.filter((key) => isKeyRead(param, key, fn.source)).length
      if (readCount >= keys.length / 2) return []
      return [{ kind: 'unread-options' as const, source: param.text, position: evidencePosition }]
    }

    if (param.name === undefined) return []
    const memberPattern = new RegExp(`\\b${escapeForRegExp(param.name)}\\??\\.\\w+`)
    if (memberPattern.test(fn.source)) return []
    return [{ kind: 'unread-options' as const, source: param.text, position: evidencePosition }]
  })

// `if (name)`, `while (name)`, and their kin share a call's `(name)` shape but
// are a condition, not an argument list, so a pass-through match on one of
// these callee words is rejected rather than counted as a call.
const controlFlowKeywords = new Set(['if', 'while', 'for', 'switch', 'catch'])

// A parameter that is only ever handed straight to another call, never read or
// branched on itself, is a pass-through; the occurrence must sit strictly
// inside the body, so a parameter mentioned only in its own signature never counts.
const passThroughEvidence = (fn: FunctionTarget, parameters: Parameter[]): Evidence[] => {
  const body = afterParameterList(fn.source)
  const offset = fn.source.length - body.length

  return parameters.flatMap((param) => {
    if (param.destructured || param.name === undefined) return []

    const occurrences = [...body.matchAll(new RegExp(`\\b${escapeForRegExp(param.name)}\\b`, 'g'))]
    if (occurrences.length !== 1) return []

    const argumentPattern = new RegExp(`([A-Za-z_$][\\w$]*)\\s*\\([^()]*\\b${escapeForRegExp(param.name)}\\b[^()]*\\)`)
    const match = argumentPattern.exec(body)
    if (!match || controlFlowKeywords.has(match[1])) return []

    const index = occurrences[0].index ?? 0
    return [{ kind: 'pass-through' as const, source: match[0].trim(), position: offset + index }]
  })
}

// A boolean-typed or boolean-defaulted parameter that steers an `if` or ternary
// is a candidate flag split; whether it is a real input or a hidden second
// function is the model's call, not this scan's.
const flagParameterEvidence = (fn: FunctionTarget, parameters: Parameter[]): Evidence[] =>
  parameters.flatMap((param) => {
    if (param.destructured || param.name === undefined) return []
    if (!/:\s*boolean\b/.test(param.text) && !/=\s*(?:true|false)\b/.test(param.text)) return []

    const name = escapeForRegExp(param.name)
    const ifMatch = new RegExp(`if\\s*\\([^()]*\\b${name}\\b[^()]*\\)`).exec(fn.source)
    const ternaryMatch = new RegExp(`\\b${name}\\b\\s*\\?`).exec(fn.source)
    const match = [ifMatch, ternaryMatch]
      .filter((candidate): candidate is RegExpExecArray => candidate !== null)
      .sort((a, b) => a.index - b.index)[0]
    if (match === undefined) return []

    return [{ kind: 'flag-parameter' as const, source: match[0].trim(), position: match.index }]
  })

// `if (true)`, `if (false)`, `if (0)`, `if (1)`, or an `if` on a fixed string:
// a condition that can never vary is dead weight around whichever branch always runs.
const literalConditionPattern = /if\s*\(\s*(?:true|false|0|1|'[^']*'|"[^"]*")\s*\)/g

const literalConditionEvidence = (fn: FunctionTarget): Evidence[] =>
  [...fn.source.matchAll(literalConditionPattern)].map((match) => ({
    kind: 'literal-condition' as const,
    source: match[0],
    position: match.index ?? 0
  }))

// A default value that is itself a function: nothing here proves any caller
// ever overrides it, which is the model's call to make from the file's contents.
const defaultCallbackPattern =
  /=\s*(?:async\s*)?(?:\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>|function\b)/

const defaultCallbackEvidence = (fn: FunctionTarget, parameters: Parameter[]): Evidence[] =>
  parameters.flatMap((param) => {
    if (!defaultCallbackPattern.test(param.text)) return []
    const position = fn.source.indexOf(param.text)
    return [{ kind: 'default-callback' as const, source: param.text, position: position === -1 ? 0 : position }]
  })

// The generic list directly before the parameter list's open paren, e.g.
// `<T, U>(...)`. A constrained type such as `T extends Base` still contributes
// only its leading identifier.
const genericListPattern = /<([^<>()]+)>\s*\(/

const declaredGenerics = (source: string): { name: string; declarationIndex: number }[] => {
  const match = genericListPattern.exec(source)
  if (!match) return []

  return match[1].split(',').flatMap((part) => {
    const nameMatch = /^\s*([A-Za-z_$][\w$]*)/.exec(part)
    return nameMatch ? [{ name: nameMatch[1], declarationIndex: match.index }] : []
  })
}

// A generic that occurs only at its own declaration and exactly one further
// spot constrains nothing: it is not shared between two positions, so nothing
// would change if the type parameter were deleted and that spot hardcoded.
const unusedGenericEvidence = (fn: FunctionTarget): Evidence[] =>
  declaredGenerics(fn.source).flatMap(({ name, declarationIndex }) => {
    const occurrences = [...fn.source.matchAll(new RegExp(`\\b${escapeForRegExp(name)}\\b`, 'g'))]
    if (occurrences.length - 1 !== 1) return []
    return [{ kind: 'unused-generic' as const, source: name, position: declarationIndex }]
  })

const speculativeEvidence = (fn: FunctionTarget, optionsParameterPatterns: RegExp[]): Evidence[] => {
  const parameters = parametersOf(fn.source)

  return [
    ...unreadOptionsEvidence(fn, parameters, optionsParameterPatterns),
    ...passThroughEvidence(fn, parameters),
    ...flagParameterEvidence(fn, parameters),
    ...literalConditionEvidence(fn),
    ...defaultCallbackEvidence(fn, parameters),
    ...unusedGenericEvidence(fn)
  ].sort((a, b) => a.position - b.position)
}

export const noSpeculativeCode: RuleFactory<NoSpeculativeCodeOptions> = (
  options = {}
): SemanticRule => {
  const { threshold, minConfidence } = resolveDecisionOptions(options, {
    threshold: defaultThreshold,
    minConfidence: defaultMinConfidence
  })
  const testFilePattern = new RegExp(options.testFilePattern ?? defaultTestFilePattern)
  const optionsParameterPatterns = (options.optionsParameterPatterns ?? defaultOptionsParameterPatterns).map(
    (pattern) => new RegExp(pattern)
  )

  return {
    description: 'Delete flexibility that nothing in this file exercises instead of carrying it as speculative generality.',
    collect(document: ParsedDocument): RuleCandidate[] {
      if (testFilePattern.test(document.filename)) return []

      return topLevelFunctions(document).flatMap((fn) => {
        const evidence = speculativeEvidence(fn, optionsParameterPatterns)
        if (evidence.length === 0) return []

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
              speculation: evidence.map(({ kind, source }) => ({ kind, source }))
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
