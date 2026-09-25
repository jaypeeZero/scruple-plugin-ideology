# scruple-plugin-ideology

A Scruple plugin enforcing the engineering ideology below as semantic lint rules, plus a disk-backed decision cache for the Scruple `DecisionProvider` contract.

## Ideals

These are ideologies, not rules. Meeting these principles is a non-stop battle; the goal is to keep reaching, not to arrive.

These ideologies apply outside of codebases and should affect how we do most of our work.

### Philosophy

- **Effort Is the Enemy** — every line of code is a liability; so is every doc, meeting, and process
- **Simplicity Over Complexity** — simple is harder than complex; put in the work to save your future self
- **Separation of Concerns** — a place for everything, and everything in its place - applies whether you're splitting a monolith or a meeting agenda
- **Choose Deliberately** — actions chosen by omission, indecision, or assumption are still decisions, and they contain unknown consequences
- **80/20** — follow what you know works 80% of the time; let context override convention the other 20%
- **Not Everything Deserves Equal Effort** — invest best thinking in the core; not every discussion or implementation deserves effort
- **Deliver Value as Often as Possible** — small, verifiable increments
- **Deliver Value as Soon as Possible** — close the gap between writing code and proving it in context; make choices that lead to earlier delivery
- **Avoid Brittle Everything** — resilience comes from simplicity and loose coupling; applies to code, docs, processes, and architectures

### Principles

- [Functional Programming](docs/ideologies/functional-programming.md) - Steal the easy stuff: Purity, composition, and declarative transformations
- [Agnostic Core](docs/ideologies/agnostic-core.md) - Keep business logic free of infrastructure concerns
- [Testing](docs/ideologies/testing.md) - Test behavior, not code
- [Codebase](docs/ideologies/codebase.md) - Code, dependencies, and configuration
- [Error Handling](docs/ideologies/error-handling.md) - Let errors bubble up, handle at the top

## Install

```
npm install --save-dev github:jaypeeZero/scruple-plugin-ideology#v0.1.0
```

```ts
// scruple.config.ts
import { defineConfig } from '@scruple/core'
import { oxcParser } from '@scruple/parser-oxc'
import { jevProvider } from '@scruple/provider-jev'
import { ideology } from 'scruple-plugin-ideology'
import { cachedProvider } from 'scruple-plugin-ideology/cached-provider'

const apiKey = process.env['TYPESAFE_API_KEY']
if (apiKey === undefined) throw new Error('TYPESAFE_API_KEY is required')

export default defineConfig({
  parser: oxcParser(),
  provider: cachedProvider(jevProvider({ apiKey })),
  include: ['src/**/*.ts'],
  plugins: { ideology: ideology() },
  rules: {
    'ideology/inject-dependencies': 'warn',
    'ideology/model-absence': 'warn',
    'ideology/no-hidden-state': 'warn',
    'ideology/prefer-declarative-transformation': 'warn',
    'ideology/translate-at-boundary': 'warn'
  }
})
```

## Rules

| Rule id | Line enforced | Options (default) |
|---|---|---|
| `inject-dependencies` | Inject dependencies. Never instantiate or import a dependency internally. | `compositionRootPattern` (`(^\|/)index\.[cm]?[jt]sx?$`), `testFilePattern` (shared default, see below), `factoryCallPatterns` (`['\.create$', '^create[A-Z]', '^make[A-Z]', '^connect$']`), `threshold` (`{ warning: 0.85, error: 0.95 }`), `minConfidence` (`0.7`) |
| `model-absence` | Model absence, don't default it. | `testFilePattern` (shared default, see below), `threshold` (`{ warning: 0.85, error: 0.95 }`), `minConfidence` (`0.7`) |
| `no-hidden-state` | Pure functions, explicit inputs, no hidden state. | `testFilePattern` (shared default, see below), `threshold` (`{ warning: 0.85, error: 0.95 }`), `minConfidence` (`0.7`) |
| `prefer-declarative-transformation` | Declarative transformations over imperative loops. | `testFilePattern` (shared default, see below), `effectCallPatterns` (`['\.forEach$']`), `threshold` (`{ warning: 0.85, error: 0.95 }`), `minConfidence` (`0.7`) |
| `translate-at-boundary` | Translate external formats at boundaries, not in core logic. | `testFilePattern` (shared default, see below), `parseCallPatterns` (`['^JSON\.parse$', '^parseInt$', '^parseFloat$', '^Number$', '^Date\.parse$', '\.split$', '\.validate(Async)?$', '\.parse$']`), `externalShapePatterns` (`['\b(payload\|query\|headers\|params\|body\|statusCode)\b', '\breq(uest)?\.', '\bres(ponse)?\.(data\|body)\b', '\brow(s)?\b']`), `threshold` (`{ warning: 0.85, error: 0.95 }`), `minConfidence` (`0.7`) |

## Shared behaviours

- Every rule's `testFilePattern` defaults to `(\.(spec|test)|[Ff]akes?|[Dd]oubles?|[Mm]ocks?|[Ss]tubs?)\.[cm]?[jt]sx?$`.
- Every rule walks top-level functions only.
- Every rule scopes by code content, never by directory layout.
- An approved exception is recorded at the site, not in configuration:

```ts
// scruple-disable-next-line ideology/no-hidden-state -- module-level cache is a deliberate exception
```

## Cached provider

Wraps a Scruple `DecisionProvider` so an identical request is answered from disk instead of the wrapped provider.

- `cachedProvider(inner, options?)` returns a `DecisionProvider` with the same `id`, `concurrency`, and `close` as `inner`.
- The cache key is the SHA-256 hash of `{ providerId: inner.id, request }`.
- Each key is one file, `<cacheDir>/<key>.json`, holding the `DecisionResponse` as written.
- `options.cacheDir` defaults to `node_modules/.cache/scruple`.
- `options.enabled` defaults to `true`. `false` makes `evaluate` a pass-through to `inner`.
- A missing, unreadable, or malformed cache file is a miss.
- A rejection from `inner.evaluate` propagates unchanged.
- A failure while writing the cache file does not fail the request.

## Evals

- `evals/` holds expected-label fixtures in Scruple's own fixture format.
- `npm run eval` runs every fixture live against Jev.
- Evals are never cached.
- Set `TYPESAFE_API_KEY` in the environment before running.

## Development

```
npm install
npm test
npm run typecheck
npm run lint
```
