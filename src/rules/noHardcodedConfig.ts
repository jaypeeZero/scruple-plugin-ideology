import { resolveDecisionOptions, resolveDiagnosticSeverity } from '@scruple/core'
import type {
  ChoiceQuestion,
  DecisionRuleOptions,
  ParsedDocument,
  Diagnostic,
  RuleCandidate,
  RuleFactory,
  SemanticRule
} from '@scruple/core'
import { boundedText } from '../bounded.ts'
import { defaultCompositionRootPattern } from '../compositionRoot.ts'
import { topLevelFunctions } from '../functions.ts'
import { defaultTestFilePattern } from '../testFiles.ts'

export interface NoHardcodedConfigOptions extends DecisionRuleOptions {
  testFilePattern?: string
  compositionRootPattern?: string
  configLiteralPatterns?: string[]
  configNamePatterns?: string[]
}

const defaultThreshold = { warning: 0.85, error: 0.95 }
const defaultMinConfidence = 0.7
const defaultConfigLiteralPatterns = [
  '^[a-z][a-z0-9+.-]*://',
  '\\b(localhost|127\\.0\\.0\\.1)\\b',
  '^(sk|pk|ghp|xox[abp]|AKIA)[A-Za-z0-9_-]{8,}',
  '\\b[A-Za-z0-9._-]+\\.(com|net|org|io|dev|internal|local)\\b',
  '^(postgres|mysql|mongodb|redis|amqp|kafka)'
]
const defaultConfigNamePatterns = [
  '(apiKey|api_key|secret|token|password|passwd|connectionString|databaseUrl|bucket|queue|topic|region|host|port)'
]

const instructions =
  'Does this function hard-code a value that would differ between deployments or that must never be committed, instead of receiving it from configuration?'

const criteria = {
  hardcodes_deploy_specific_value:
    'A host, URL, connection string, credential, key, secret, bucket, queue, topic, region, or port is written as a literal here, or process.env is read inside business logic rather than at a composition root.',
  fixed_protocol_constant:
    'The literal never changes between deployments: a well-known scheme or media type, a public standards URL used as an identifier (XML namespace, JSON schema $id), an HTTP status, a header name, a relative path inside the codebase.',
  declared_default_for_injected_option:
    'The literal is the documented default of a parameter or option the caller can override, and it is not a credential.',
  insufficient_context:
    'Whether the literal varies by deployment cannot be determined from the function shown.'
}

const finding = 'hardcodes_deploy_specific_value'
const message = 'Read this value from configuration at the edge and pass it in.'

// String literals only, quotes stripped: single- and double-quoted strings, plus
// template literals that hold no interpolation (`${`). An interpolated template
// mixes computed and fixed text, so its content is not a literal to classify.
const stringLiteralContents = (line: string): string[] => {
  const pattern = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g
  const contents: string[] = []
  for (const match of line.matchAll(pattern)) {
    const raw = match[0]
    if (raw.startsWith('`') && raw.includes('${')) continue
    contents.push(raw.slice(1, -1))
  }
  return contents
}

const hasConfigLiteral = (line: string, patterns: RegExp[]): boolean =>
  stringLiteralContents(line).some((content) => patterns.some((pattern) => pattern.test(content)))

// A line where an identifier (a variable name or an object key) is directly
// assigned a string or number literal; `??`/`||` fallbacks and other
// expressions in between are why this only looks right after `:`/`=`.
const identifierAssignedLiteralPattern =
  /([A-Za-z_$][\w$]*)\s*[:=](?!=)\s*(?:'[^']*'|"[^"]*"|`[^`]*`|-?\d+(?:\.\d+)?)/g

const hasConfigNameHint = (line: string, patterns: RegExp[]): boolean => {
  for (const match of line.matchAll(identifierAssignedLiteralPattern)) {
    if (patterns.some((pattern) => pattern.test(match[1]))) return true
  }
  return false
}

const envReadPattern = /process\.env(?:\.[A-Za-z_$][\w$]*|\[['"][^'"]*['"]\])/

export const noHardcodedConfig: RuleFactory<NoHardcodedConfigOptions> = (
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
  const configLiteralPatterns = (options.configLiteralPatterns ?? defaultConfigLiteralPatterns).map(
    (pattern) => new RegExp(pattern)
  )
  const configNamePatterns = (options.configNamePatterns ?? defaultConfigNamePatterns).map(
    (pattern) => new RegExp(pattern, 'i')
  )

  return {
    description: 'Configuration should be read from the environment at a composition root, not hardcoded in business logic.',
    collect(document: ParsedDocument): RuleCandidate[] {
      if (testFilePattern.test(document.filename)) return []
      if (compositionRootPattern.test(document.filename)) return []

      return topLevelFunctions(document).flatMap((fn) => {
        const literals: string[] = []
        const envReads: string[] = []
        const seenLiterals = new Set<string>()
        const seenEnvReads = new Set<string>()

        for (const rawLine of fn.source.split('\n')) {
          const line = rawLine.trim()
          if (line === '') continue

          if (
            !seenLiterals.has(line) &&
            (hasConfigLiteral(line, configLiteralPatterns) || hasConfigNameHint(line, configNamePatterns))
          ) {
            seenLiterals.add(line)
            literals.push(line)
          }

          if (!seenEnvReads.has(line) && envReadPattern.test(line)) {
            seenEnvReads.add(line)
            envReads.push(line)
          }
        }

        if (literals.length === 0 && envReads.length === 0) return []

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
              literals,
              envReads
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
