// String and non-interpolated template literals only. An interpolated template mixes
// computed and fixed text, so it is never treated as a fixed literal by callers of
// either function below.
const stringLiteralPattern = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g

const isInterpolatedTemplate = (raw: string): boolean => raw.startsWith('`') && raw.includes('${')

export const stringLiteralContents = (line: string): string[] => {
  const contents: string[] = []
  for (const match of line.matchAll(stringLiteralPattern)) {
    const raw = match[0]
    if (isInterpolatedTemplate(raw)) continue
    contents.push(raw.slice(1, -1))
  }
  return contents
}

// Replaces each string or non-interpolated template literal with spaces of the same
// length, so a caller can test surrounding punctuation (a colon, a slash, a question
// mark) without a quoted value's own characters colliding with that structure. Every
// other character keeps its original index; an interpolated template is left untouched.
export const stripStringLiterals = (source: string): string =>
  source.replace(stringLiteralPattern, (raw) => (isInterpolatedTemplate(raw) ? raw : ' '.repeat(raw.length)))
