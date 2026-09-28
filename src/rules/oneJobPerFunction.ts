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
import { matchesAny } from '../patterns.ts'
import { stripStringLiterals } from '../stringLiterals.ts'
import { defaultTestFilePattern } from '../testFiles.ts'

export interface OneJobPerFunctionOptions extends DecisionRuleOptions {
  testFilePattern?: string
  minLines?: number
  ioCallPatterns?: string[]
  presentationCallPatterns?: string[]
  validationCallPatterns?: string[]
}

const defaultThreshold = { warning: 0.85, error: 0.95 }
const defaultMinConfidence = 0.7
const defaultMinLines = 40
const defaultIoCallPatterns = [
  '^(fetch|axios|got)\\b',
  '\\.(query|execute|find\\w*|save|insert|update|delete|put\\w*|get\\w*Object|send|publish|subscribe|readFile\\w*|writeFile\\w*|connect)$'
]
const defaultPresentationCallPatterns = [
  '^(console|logger|log)\\.',
  '\\.(toFixed|toLocale\\w+|padStart|padEnd|format|render)$'
]
const defaultValidationCallPatterns = [
  '\\.(validate|assert\\w*|check\\w*|is[A-Z]\\w*)$',
  '^(assert|invariant|z\\.|yup\\.|joi\\.)'
]

// Presentation is also hit when a function builds enough of its own output text
// that no single call site carries the evidence; three or more template literals
// is a plain, fixed threshold rather than an option, since it names a shape
// (string assembly), not a policy a caller would want to retune per project.
const presentationTemplateLiteralThreshold = 3
const templateLiteralPattern = /`(?:[^`\\]|\\.)*`/g

const instructions =
  'Does this function have more than one obvious job — mixing I/O, presentation, validation, or business rules in one body — rather than doing one thing and delegating the rest? Ignore the decode-versus-domain split; another rule owns that.'

const criteria = {
  mixes_concerns:
    'Two or more of these live in the same body: talking to a network, database, file, or queue; formatting output for people or logs; validating input shape; deciding business rules. Removing one would leave a function with a different, narrower purpose.',
  single_concern:
    'The body does one job. Orchestrating injected collaborators in sequence, and branching on their results, counts as the single job of a service or use-case function.',
  thin_entry_point:
    'The function is an entry point (route handler, CLI command, event handler) whose job is to wire request to core to response; it holds no business rules of its own.',
  insufficient_context:
    'The callees\' roles cannot be determined from the function shown.'
}

const finding = 'mixes_concerns'
const message = 'Split this function so each piece has one obvious job.'

type ConcernBucket = 'io' | 'presentation' | 'validation' | 'orchestration'

interface Concern {
  bucket: ConcernBucket
  callees: string[]
}

// A parameter list can hold destructuring and default values that no rule here
// needs to resolve; a bare identifier is the only shape that can ever be the root
// of an orchestration callee (`repo.save`), so anything else is simply skipped.
const parameterNames = (fn: FunctionTarget): Set<string> => {
  const names = parameterListText(fn.source)
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => part.replace(/[:=].*$/, '').trim())
    .filter((name) => /^[A-Za-z_$][\w$]*$/.test(name))
  return new Set(names)
}

const calleeRoot = (callee: string): string => callee.split('.')[0]

// Every call is classified into at most one bucket: the first pattern list it
// matches, or orchestration when it matches none but is a member call on a
// parameter, or nothing at all otherwise.
const classifyCalls = (
  fn: FunctionTarget,
  ioCallPatterns: RegExp[],
  presentationCallPatterns: RegExp[],
  validationCallPatterns: RegExp[]
): Record<ConcernBucket, string[]> => {
  const buckets: Record<ConcernBucket, string[]> = {
    io: [],
    presentation: [],
    validation: [],
    orchestration: []
  }
  const params = parameterNames(fn)

  for (const call of fn.calls) {
    if (matchesAny(ioCallPatterns, call.callee)) {
      buckets.io.push(call.callee)
    } else if (matchesAny(presentationCallPatterns, call.callee)) {
      buckets.presentation.push(call.callee)
    } else if (matchesAny(validationCallPatterns, call.callee)) {
      buckets.validation.push(call.callee)
    } else if (params.has(calleeRoot(call.callee))) {
      buckets.orchestration.push(call.callee)
    }
  }

  return buckets
}

const concernsFor = (
  fn: FunctionTarget,
  ioCallPatterns: RegExp[],
  presentationCallPatterns: RegExp[],
  validationCallPatterns: RegExp[]
): Concern[] => {
  const buckets = classifyCalls(fn, ioCallPatterns, presentationCallPatterns, validationCallPatterns)
  const templateLiteralCount = [...fn.source.matchAll(templateLiteralPattern)].length
  const hasPresentation =
    buckets.presentation.length > 0 || templateLiteralCount >= presentationTemplateLiteralThreshold

  const concerns: Concern[] = []
  if (buckets.io.length > 0) concerns.push({ bucket: 'io', callees: [...new Set(buckets.io)] })
  if (hasPresentation) concerns.push({ bucket: 'presentation', callees: [...new Set(buckets.presentation)] })
  if (buckets.validation.length > 0) concerns.push({ bucket: 'validation', callees: [...new Set(buckets.validation)] })
  if (buckets.orchestration.length > 0) {
    concerns.push({ bucket: 'orchestration', callees: [...new Set(buckets.orchestration)] })
  }
  return concerns
}

// Business logic leaves no callee evidence, so it is reported to the model only as
// a count of decision points: `if`/`switch` statements, ternaries (a bare `?`
// outside string content), and `&&`-guards.
const branchCount = (fn: FunctionTarget): number => {
  const stripped = stripStringLiterals(fn.source)
  const ifCount = [...stripped.matchAll(/\bif\s*\(/g)].length
  const switchCount = [...stripped.matchAll(/\bswitch\s*\(/g)].length
  const ternaryCount = [...stripped.matchAll(/\?/g)].length
  const guardCount = [...stripped.matchAll(/&&/g)].length
  return ifCount + switchCount + ternaryCount + guardCount
}

const nonBlankLineCount = (source: string): number =>
  source.split('\n').filter((line) => line.trim() !== '').length

export const oneJobPerFunction: RuleFactory<OneJobPerFunctionOptions> = (
  options = {}
): SemanticRule => {
  const { threshold, minConfidence } = resolveDecisionOptions(options, {
    threshold: defaultThreshold,
    minConfidence: defaultMinConfidence
  })
  const testFilePattern = new RegExp(options.testFilePattern ?? defaultTestFilePattern)
  const minLines = options.minLines ?? defaultMinLines
  const ioCallPatterns = (options.ioCallPatterns ?? defaultIoCallPatterns).map((pattern) => new RegExp(pattern))
  const presentationCallPatterns = (options.presentationCallPatterns ?? defaultPresentationCallPatterns).map(
    (pattern) => new RegExp(pattern)
  )
  const validationCallPatterns = (options.validationCallPatterns ?? defaultValidationCallPatterns).map(
    (pattern) => new RegExp(pattern)
  )

  return {
    description: 'Each function, class, module, and layer has one obvious job; split a function that does too much.',
    collect(document: ParsedDocument): RuleCandidate[] {
      if (testFilePattern.test(document.filename)) return []

      return topLevelFunctions(document).flatMap((fn) => {
        const concerns = concernsFor(fn, ioCallPatterns, presentationCallPatterns, validationCallPatterns)
        const branches = branchCount(fn)
        const lineCount = nonBlankLineCount(fn.source)

        const primaryConcernCount = concerns.filter((concern) => concern.bucket !== 'orchestration').length
        const isCandidate =
          primaryConcernCount >= 2 ||
          (primaryConcernCount === 1 && branches >= 2) ||
          lineCount > minLines

        if (!isCandidate) return []

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
              concerns: concerns.map((concern) => ({ bucket: concern.bucket, callees: concern.callees })),
              branchCount: branches,
              lineCount
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
