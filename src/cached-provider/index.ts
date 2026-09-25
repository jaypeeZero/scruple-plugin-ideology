import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DecisionProvider, DecisionRequest, DecisionResponse } from '@scruple/core'

export interface CachedProviderOptions {
  cacheDir?: string
  enabled?: boolean
}

const defaultCacheDir = join('node_modules', '.cache', 'scruple')

const cacheKeyFor = (providerId: string, request: DecisionRequest): string =>
  createHash('sha256')
    .update(JSON.stringify({ providerId, request }))
    .digest('hex')

const readCachedResponse = async (path: string): Promise<DecisionResponse | undefined> => {
  try {
    const contents = await readFile(path, 'utf8')
    return JSON.parse(contents) as DecisionResponse
  } catch {
    return undefined
  }
}

const writeCachedResponse = async (path: string, response: DecisionResponse): Promise<void> => {
  try {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, JSON.stringify(response))
  } catch {
    // cache is an optimisation; a write failure must not fail the run
  }
}

export const cachedProvider = (
  inner: DecisionProvider,
  options: CachedProviderOptions = {}
): DecisionProvider => {
  const cacheDir = options.cacheDir ?? defaultCacheDir
  const enabled = options.enabled ?? true

  return {
    id: inner.id,
    concurrency: inner.concurrency,
    evaluate: async (request: DecisionRequest, signal?: AbortSignal): Promise<DecisionResponse> => {
      if (!enabled) return inner.evaluate(request, signal)

      const path = join(cacheDir, `${cacheKeyFor(inner.id, request)}.json`)
      const cached = await readCachedResponse(path)
      if (cached !== undefined) return cached

      const response = await inner.evaluate(request, signal)
      await writeCachedResponse(path, response)
      return response
    },
    close: inner.close
  }
}
