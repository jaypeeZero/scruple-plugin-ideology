import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import { declarationOf } from '../src/declaration.ts'
import { topLevelFunctions } from '../src/functions.ts'

const parser = oxcParser()

const onlyDeclaration = (filename: string, source: string) => {
  const document = parser.parse(filename, source)
  const [fn] = topLevelFunctions(document)
  return declarationOf(document, fn)
}

test('names an exported arrow function and its file', t => {
  const declaration = onlyDeclaration('src/services/createClient.ts', `
    export const createClient = (options) => options.baseUrl
  `)

  t.deepEqual(declaration, { filename: 'src/services/createClient.ts', name: 'createClient', exported: true })
})

test('marks a function declaration without export as not exported', t => {
  const declaration = onlyDeclaration('src/services/format.ts', `
    function format(value) {
      return String(value)
    }
  `)

  t.is(declaration.name, 'format')
  t.false(declaration.exported)
})

test('marks an exported function declaration as exported', t => {
  const declaration = onlyDeclaration('src/services/format.ts', `
    export async function format(value) {
      return String(value)
    }
  `)

  t.true(declaration.exported)
})

test('marks a function exported later through an export list as exported', t => {
  const declaration = onlyDeclaration('src/services/format.ts', `
    const format = (value) => String(value)

    export { format }
  `)

  t.true(declaration.exported)
})

test('carries the doc comment written directly above the declaration', t => {
  const declaration = onlyDeclaration('src/index.ts', `
    /** Public API: callers construct these options. */
    export const createClient = (options) => options.baseUrl
  `)

  t.is(declaration.docComment, 'Public API: callers construct these options.')
})

test('ignores a comment separated from the declaration by other code', t => {
  const declaration = onlyDeclaration('src/services/format.ts', `
    // retries are tuned in ops
    const limit = 3
    export const format = (value) => String(value).slice(0, limit)
  `)

  t.is(declaration.docComment, undefined)
})
