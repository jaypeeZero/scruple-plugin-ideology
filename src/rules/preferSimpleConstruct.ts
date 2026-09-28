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

export interface PreferSimpleConstructOptions extends DecisionRuleOptions {
  testFilePattern?: string
}

const defaultThreshold = { warning: 0.85, error: 0.95 }
const defaultMinConfidence = 0.7

const instructions =
  'Does this function use a clever construct where a plainer one would meet the same requirement and be easier to read?'

const criteria = {
  clever_where_simple_suffices:
    'A nested ternary that an if/else or lookup table would express, a reduce that builds a collection which map/filter/Object.fromEntries would build directly, a regex doing a plain startsWith/includes/split, a bitwise or double-negation trick for arithmetic or boolean coercion, or eval/Function/Proxy/Reflect/arguments in ordinary business logic.',
  simplest_correct_option:
    'The construct is the plainest thing that is actually correct here: the regex has real alternation or classes, the reduce genuinely folds to a scalar or needs the running accumulator, the ternary is a single level, the bitwise op is on real bit flags.',
  performance_or_compat_justified_inline:
    'A comment in the function states a measured performance or compatibility reason for the construct.',
  insufficient_context:
    'Whether a plainer construct would meet the requirement cannot be judged from the function shown.'
}

const finding = 'clever_where_simple_suffices'
const message = 'Replace this construct with the plainer one that meets the same requirement.'

type ConstructKind = 'nested-ternary' | 'reduce-to-collection' | 'regex-for-string-op' | 'bitwise-trick' | 'meta-programming'

interface Construct {
  kind: ConstructKind
  source: string
}

// Two or more `?` with a matching `:` outside string literals, tested per line so a
// single-level ternary elsewhere in the same function does not turn the whole
// function into one long false match. The chained "else-if" idiom nests the next
// ternary in the false branch, so a `:` can fall between the first `?` and the
// second; only the segment after the second `?` must be colon-free to land on that
// ternary's own `:`.
const nestedTernaryPattern = /\?[^?]*\?[^:]*:/

const nestedTernaries = (fn: { source: string }): Construct[] => {
  const constructs: Construct[] = []
  const rawLines = fn.source.split('\n')
  for (const rawLine of rawLines) {
    const line = rawLine.trim()
    if (line === '') continue
    if (nestedTernaryPattern.test(stripStringLiterals(line))) {
      constructs.push({ kind: 'nested-ternary', source: line })
    }
  }
  return constructs
}

// Whether the accumulator is a collection is the model's call once flagged
// (`simplest_correct_option` covers a reduce that genuinely folds to a scalar), so
// this only recognizes the shape of the initial value, never its later use.
const isCollectionInitializer = (text: string): boolean => {
  const trimmed = text.trim()
  return trimmed === '{}' || trimmed === '[]' || /^new\s+(Map|Set)\b/.test(trimmed)
}

// `.reduce(` is found positionally and its argument list is walked with a bracket
// depth counter to find the last top-level comma, since the callback's own
// parameter list and body can contain any number of nested commas, parens, and
// braces before the initial-value argument is reached.
const reduceCalls = (fn: { source: string }): Construct[] => {
  const constructs: Construct[] = []
  const callPattern = /\.reduce\(/g
  for (const match of fn.source.matchAll(callPattern)) {
    const start = match.index + match[0].length
    let depth = 1
    let end = -1
    let lastTopLevelComma = -1
    for (let i = start; i < fn.source.length; i++) {
      const char = fn.source[i]
      if (char === '(' || char === '[' || char === '{') {
        depth++
      } else if (char === ')' || char === ']' || char === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      } else if (char === ',' && depth === 1) {
        lastTopLevelComma = i
      }
    }
    if (end === -1 || lastTopLevelComma === -1) continue

    const initialValue = fn.source.slice(lastTopLevelComma + 1, end)
    if (isCollectionInitializer(initialValue)) {
      constructs.push({ kind: 'reduce-to-collection', source: fn.source.slice(match.index, end + 1).trim() })
    }
  }
  return constructs
}

// A regex literal whose body, once its `^`/`$` anchors are set aside, has none of
// the characters that give a regex its power (`. * + ? ( ) [ ] { } | \`) is doing
// nothing a plain string operation could not; a real pattern with classes or
// alternation is left alone.
const regexLiteralPattern = /\/((?:\\.|[^\\/\n])+)\/[a-z]*/g
const plainAnchoredBodyPattern = /^\^?[^.*+?()[\]{}|\\^$]*\$?$/

const regexesForStringOps = (fn: { source: string }): Construct[] => {
  const constructs: Construct[] = []
  const stripped = stripStringLiterals(fn.source)
  for (const match of stripped.matchAll(regexLiteralPattern)) {
    if (plainAnchoredBodyPattern.test(match[1])) {
      constructs.push({ kind: 'regex-for-string-op', source: fn.source.slice(match.index, match.index + match[0].length) })
    }
  }
  return constructs
}

// Each pattern is one specific trick, not a general sweep for bitwise operators, so
// a real flag check like `permissions & WRITE` still counts as evidence (the model
// decides whether it is real bit-flag usage via `simplest_correct_option`) while
// ordinary arithmetic and boolean logic elsewhere never matches.
const bitwiseTrickPatterns = [
  /~~/,
  /\|\s*0\b/,
  /<<\s*0\b/,
  />>>\s*0\b/,
  /!!/,
  /\^\s*1\b/,
  /&\s*1\b/,
  /&\s*[A-Za-z_$][\w$]*\)\s*!==?\s*0/
]

const bitwiseTricks = (fn: { source: string }): Construct[] => {
  const constructs: Construct[] = []
  const rawLines = fn.source.split('\n')
  for (const rawLine of rawLines) {
    const line = rawLine.trim()
    if (line === '') continue
    if (bitwiseTrickPatterns.some((pattern) => pattern.test(line))) {
      constructs.push({ kind: 'bitwise-trick', source: line })
    }
  }
  return constructs
}

const metaProgrammingPatterns = [
  /\beval\(/,
  /new Function\(/,
  /\bProxy\b/,
  /\bReflect\./,
  /\barguments\b/,
  /\(\s*[^()]*,\s*[^()]*\)\s*(;|$)/
]

const metaProgramming = (fn: { source: string }): Construct[] => {
  const constructs: Construct[] = []
  const rawLines = fn.source.split('\n')
  for (const rawLine of rawLines) {
    const line = rawLine.trim()
    if (line === '') continue
    if (metaProgrammingPatterns.some((pattern) => pattern.test(line))) {
      constructs.push({ kind: 'meta-programming', source: line })
    }
  }
  return constructs
}

export const preferSimpleConstruct: RuleFactory<PreferSimpleConstructOptions> = (
  options = {}
): SemanticRule => {
  const { threshold, minConfidence } = resolveDecisionOptions(options, {
    threshold: defaultThreshold,
    minConfidence: defaultMinConfidence
  })
  const testFilePattern = new RegExp(options.testFilePattern ?? defaultTestFilePattern)

  return {
    description: 'Never choose a clever construct when a plainer one meets the same requirement.',
    collect(document: ParsedDocument): RuleCandidate[] {
      if (testFilePattern.test(document.filename)) return []

      return topLevelFunctions(document).flatMap((fn) => {
        if (loopRegionsWithin(document, fn).length > 0) return []

        const constructs: Construct[] = [
          ...nestedTernaries(fn),
          ...reduceCalls(fn),
          ...regexesForStringOps(fn),
          ...bitwiseTricks(fn),
          ...metaProgramming(fn)
        ]

        if (constructs.length === 0) return []

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
              constructs: constructs.map((construct) => ({ kind: construct.kind, source: construct.source }))
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
