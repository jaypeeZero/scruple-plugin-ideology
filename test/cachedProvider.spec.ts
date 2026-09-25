import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import anyTest, { type TestFn } from 'ava'
import type { DecisionProvider, DecisionRequest, DecisionResponse } from '@scruple/core'
import { cachedProvider } from '../src/cached-provider/index.ts'

const test = anyTest as TestFn<{ cacheDir: string }>

const request: DecisionRequest = {
  state: { function: 'const a = 1' },
  questions: {
    q: { type: 'noul', instructions: 'is this fine?' }
  }
}

const response: DecisionResponse = {
  model: 'fake-model',
  answers: {
    q: { type: 'noul', noul: 0.5 }
  }
}

const fakeProvider = (result: DecisionResponse = response): DecisionProvider & { calls: number } => {
  const provider = {
    id: 'fake',
    calls: 0,
    evaluate: async () => {
      provider.calls += 1
      return result
    }
  }
  return provider
}

test.beforeEach(async t => {
  t.context.cacheDir = await mkdtemp(join(tmpdir(), 'scruple-cache-'))
})

test.afterEach(async t => {
  await rm(t.context.cacheDir, { recursive: true, force: true })
})

test('calls the inner provider once on a cache miss and returns its response', async t => {
  const inner = fakeProvider()
  const provider = cachedProvider(inner, { cacheDir: t.context.cacheDir })

  const result = await provider.evaluate(request)

  t.is(inner.calls, 1)
  t.deepEqual(result, response)
})

test('does not call the inner provider again for an identical request', async t => {
  const inner = fakeProvider()
  const provider = cachedProvider(inner, { cacheDir: t.context.cacheDir })

  const first = await provider.evaluate(request)
  const second = await provider.evaluate(request)

  t.is(inner.calls, 1)
  t.deepEqual(second, first)
})

test('treats a corrupt cache file as a miss and overwrites it', async t => {
  const inner = fakeProvider()
  const provider = cachedProvider(inner, { cacheDir: t.context.cacheDir })

  await mkdir(t.context.cacheDir, { recursive: true })
  const key = createHash('sha256')
    .update(JSON.stringify({ providerId: inner.id, request }))
    .digest('hex')
  const path = join(t.context.cacheDir, `${key}.json`)
  await writeFile(path, 'not valid json')

  const result = await provider.evaluate(request)

  t.is(inner.calls, 1)
  t.deepEqual(result, response)
  t.deepEqual(JSON.parse(await readFile(path, 'utf8')), response)
})

test('propagates a rejection from the inner provider and writes no cache file', async t => {
  const inner: DecisionProvider & { calls: number } = {
    id: 'fake',
    calls: 0,
    evaluate: async () => {
      inner.calls += 1
      throw new Error('inner provider failed')
    }
  }
  const provider = cachedProvider(inner, { cacheDir: t.context.cacheDir })

  await t.throwsAsync(provider.evaluate(request), { message: 'inner provider failed' })

  const key = createHash('sha256')
    .update(JSON.stringify({ providerId: inner.id, request }))
    .digest('hex')
  const path = join(t.context.cacheDir, `${key}.json`)
  await t.throwsAsync(readFile(path, 'utf8'))
  t.is(inner.calls, 1)
})

test('calls the inner provider on every request when disabled', async t => {
  const inner = fakeProvider()
  const provider = cachedProvider(inner, { cacheDir: t.context.cacheDir, enabled: false })

  await provider.evaluate(request)
  await provider.evaluate(request)

  t.is(inner.calls, 2)
})

test('calls the inner provider again for a different request', async t => {
  const inner = fakeProvider()
  const provider = cachedProvider(inner, { cacheDir: t.context.cacheDir })
  const otherRequest: DecisionRequest = {
    ...request,
    state: { function: 'const a = 2' }
  }

  await provider.evaluate(request)
  await provider.evaluate(otherRequest)

  t.is(inner.calls, 2)
})
