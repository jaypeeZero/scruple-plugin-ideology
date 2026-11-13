import type { CommentTarget, FunctionTarget, ParsedDocument } from '@scruple/core'

// A type alias, not an interface, so it stays assignable to the engine's JsonValue state.
export type Declaration = {
  filename: string
  name?: string
  exported: boolean
  docComment?: string
}

const escapeForRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const exportPatterns = (name: string): RegExp[] => {
  const escaped = escapeForRegExp(name)
  return [
    new RegExp(`\\bexport\\s+(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${escaped}\\b`),
    new RegExp(`\\bexport\\s+(?:const|let|var)\\s+${escaped}\\b`),
    new RegExp(`\\bexport\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`),
    new RegExp(`\\bexport\\s+default\\s+${escaped}\\b`)
  ]
}

// A method shares its name with nothing at module scope, so only a free
// function can be exported by name.
const isExported = (document: ParsedDocument, fn: FunctionTarget): boolean =>
  fn.name !== undefined &&
  fn.role !== 'method' &&
  exportPatterns(fn.name).some((pattern) => pattern.test(document.source))

// Between a doc comment and the function it documents there may only be the
// declaration's own head (`export const name =`), never other statements.
const declarationHeadPattern =
  /^\s*(?:export\s+(?:default\s+)?)?(?:(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::[^=;]*)?=\s*)?$/

const normalizedCommentText = (comment: CommentTarget): string =>
  comment.value
    .split('\n')
    .map((line) => line.replace(/^\s*\*+\s?/, '').trim())
    .filter((line) => line !== '')
    .join(' ')

const docCommentOf = (document: ParsedDocument, fn: FunctionTarget): string | undefined => {
  const preceding = document.comments
    .filter((comment) => comment.range.end <= fn.range.start)
    .sort((a, b) => b.range.end - a.range.end)[0]
  if (preceding === undefined) return undefined

  const between = document.source.slice(preceding.range.end, fn.range.start)
  if (!declarationHeadPattern.test(between)) return undefined

  const text = normalizedCommentText(preceding)
  return text === '' ? undefined : text
}

/** Facts about where and how a function is declared, which its source text alone omits for arrow functions. */
export const declarationOf = (document: ParsedDocument, fn: FunctionTarget): Declaration => {
  const docComment = docCommentOf(document, fn)
  return {
    filename: document.filename,
    ...(fn.name === undefined ? {} : { name: fn.name }),
    exported: isExported(document, fn),
    ...(docComment === undefined ? {} : { docComment })
  }
}
