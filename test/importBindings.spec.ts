import test from 'ava'
import { oxcParser } from '@scruple/parser-oxc'
import { defaultInfrastructureImportPatterns, importBindings } from '../src/importBindings.ts'

const parser = oxcParser()

const infraPatterns = defaultInfrastructureImportPatterns.map((pattern) => new RegExp(pattern))

test('binds the default import name for a default-only import', t => {
  const document = parser.parse('src/services/orders.ts', `
    import Stripe from 'stripe'
    export const noop = () => 1
  `)

  t.deepEqual(importBindings(document, infraPatterns), [{ specifier: 'stripe', bindings: ['Stripe'] }])
})

test('binds each named import, using the alias rather than the original name', t => {
  const document = parser.parse('src/services/pricing.ts', `
    import { Pool, Client as PgClient } from 'pg'
    export const noop = () => 1
  `)

  t.deepEqual(importBindings(document, infraPatterns), [
    { specifier: 'pg', bindings: ['Pool', 'PgClient'] }
  ])
})

test('binds the namespace import name for a namespace import', t => {
  const document = parser.parse('src/services/handler.ts', `
    import * as express from 'express'
    export const noop = () => 1
  `)

  t.deepEqual(importBindings(document, infraPatterns), [
    { specifier: 'express', bindings: ['express'] }
  ])
})

test('binds both the default and the named imports for a combined import', t => {
  const document = parser.parse('src/services/eligibility.ts', `
    import axios, { AxiosError } from 'axios'
    export const noop = () => 1
  `)

  t.deepEqual(importBindings(document, infraPatterns), [
    { specifier: 'axios', bindings: ['axios', 'AxiosError'] }
  ])
})

test('binds both the default and the namespace import for a combined default-plus-namespace import', t => {
  const document = parser.parse('src/services/mailer.ts', `
    import Twilio, * as twilioNs from 'twilio'
    export const noop = () => 1
  `)

  t.deepEqual(importBindings(document, infraPatterns), [
    { specifier: 'twilio', bindings: ['Twilio', 'twilioNs'] }
  ])
})

test('binds nothing for a side-effect-only import', t => {
  const document = parser.parse('src/services/sideEffect.ts', `
    import 'stripe/register'
    export const noop = () => 1
  `)

  t.deepEqual(importBindings(document, infraPatterns), [
    { specifier: 'stripe/register', bindings: [] }
  ])
})

test('excludes a specifier that matches none of the given patterns', t => {
  const document = parser.parse('src/services/util.ts', `
    import { format } from 'date-fns'
    export const noop = () => 1
  `)

  t.deepEqual(importBindings(document, infraPatterns), [])
})

test('a custom pattern list swaps which specifiers count', t => {
  const document = parser.parse('src/services/orm.ts', `
    import { connect } from 'my-orm'
    export const noop = () => 1
  `)

  t.deepEqual(importBindings(document, infraPatterns), [])
  t.deepEqual(importBindings(document, [/^my-orm$/]), [
    { specifier: 'my-orm', bindings: ['connect'] }
  ])
})
