// Splits a parameter list (or a destructuring pattern's inner text) on its
// top-level commas, tracking bracket depth so a nested object, array, or
// default-value literal never breaks a single parameter in two.
export const splitTopLevelParams = (text: string): string[] => {
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
export const boundNames = (segment: string): string[] => {
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

// Finds the parameter list's matching close paren with a depth counter. Brackets
// nest, but the sources these rules see never hide parens inside a string, so a
// plain counter is enough. An arrow function with a single bare parameter has
// no parens at all, so the text before `=>` is the whole list.
export const parameterListText = (source: string): string => {
  const openParen = source.indexOf('(')
  const arrow = source.indexOf('=>')
  if (openParen === -1 || (arrow !== -1 && arrow < openParen)) {
    return arrow === -1 ? '' : source.slice(0, arrow)
  }

  let depth = 0
  for (let i = openParen; i < source.length; i++) {
    if (source[i] === '(') depth++
    else if (source[i] === ')') {
      depth--
      if (depth === 0) return source.slice(openParen + 1, i)
    }
  }
  return source.slice(openParen + 1)
}
