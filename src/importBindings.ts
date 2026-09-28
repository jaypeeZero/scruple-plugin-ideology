import type { ParsedDocument } from '@scruple/core'
import { splitTopLevelParams } from './parameters.ts'

export interface ImportBinding {
  specifier: string
  bindings: string[]
}

export const defaultInfrastructureImportPatterns = [
  '^node:(fs|http|https|net|child_process|dgram)',
  '^(pg|mysql2?|mongodb|mongoose|ioredis|redis|kafkajs|amqplib|knex|prisma|@prisma/client|typeorm|sequelize|drizzle-orm)$',
  '^@aws-sdk/',
  '^aws-sdk$',
  '^(axios|got|node-fetch|undici|ky)$',
  '^(express|fastify|koa|hono|@nestjs/)',
  '^(nodemailer|twilio|stripe|@stripe/|@sendgrid/)'
]

// `document.imports` holds each statement's own source text (oxc keeps the leading
// `type` keyword, so a type-only import is not distinguished here; whether a binding
// is used as a value or only as a type is left to the callers of this module).
const importStatementPattern = /import\s+(?:type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/
const sideEffectImportPattern = /^import\s*['"]([^'"]+)['"]/

// The clause between `import` and `from` splits on its top-level commas the same
// way a parameter list does, since a named block's own commas must not count:
// `defaultExport, { a, b as c }` is two top-level segments, not four.
const bindingsInClause = (clause: string): string[] =>
  splitTopLevelParams(clause).flatMap((segment) => {
    const trimmed = segment.trim()
    if (trimmed === '') return []

    if (trimmed.startsWith('{')) {
      const closeIndex = trimmed.lastIndexOf('}')
      const inner = trimmed.slice(1, closeIndex === -1 ? trimmed.length : closeIndex)
      return inner
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .map((part) => {
          const asMatch = /^.+?\sas\s+([\w$]+)$/.exec(part)
          return asMatch ? asMatch[1] : part
        })
    }

    if (trimmed.startsWith('*')) {
      const namespaceMatch = /\*\s*as\s+([\w$]+)/.exec(trimmed)
      return namespaceMatch ? [namespaceMatch[1]] : []
    }

    return [trimmed]
  })

// A side-effect import (`import 'x'`) has no clause before `from` at all and
// binds nothing; every other shape binds at least one local name.
const parseImportStatement = (statement: string): ImportBinding | undefined => {
  const withClause = importStatementPattern.exec(statement)
  if (withClause) {
    return { specifier: withClause[2], bindings: bindingsInClause(withClause[1]) }
  }

  const sideEffect = sideEffectImportPattern.exec(statement)
  if (sideEffect) {
    return { specifier: sideEffect[1], bindings: [] }
  }

  return undefined
}

// Grouped by specifier, since two separate import statements for the same module
// contribute bindings to a single entry rather than one per statement.
export const importBindings = (document: ParsedDocument, patterns: RegExp[]): ImportBinding[] => {
  const bySpecifier = new Map<string, string[]>()

  for (const statement of document.imports) {
    const parsed = parseImportStatement(statement)
    if (parsed === undefined) continue
    if (!patterns.some((pattern) => pattern.test(parsed.specifier))) continue

    const existing = bySpecifier.get(parsed.specifier)
    if (existing) {
      existing.push(...parsed.bindings)
    } else {
      bySpecifier.set(parsed.specifier, [...parsed.bindings])
    }
  }

  return [...bySpecifier.entries()].map(([specifier, bindings]) => ({ specifier, bindings }))
}
