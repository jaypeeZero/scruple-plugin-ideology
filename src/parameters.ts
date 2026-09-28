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
