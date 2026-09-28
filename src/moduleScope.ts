import type { ParsedDocument } from '@scruple/core'

// `StructuredDeclarationFact.kind` only reports `using`/`await-using` bindings; the
// parser has no fact for a module-level `let`/`const`. Module scope is therefore
// derived directly from the source: everything outside every function's range.
export const moduleScopeSource = (document: ParsedDocument): string => {
  const ranges = [...document.functions].map((fn) => fn.range).sort((a, b) => a.start - b.start)

  let text = ''
  let cursor = 0
  for (const range of ranges) {
    text += document.source.slice(cursor, range.start)
    cursor = Math.max(cursor, range.end)
  }
  text += document.source.slice(cursor)

  return text
}
