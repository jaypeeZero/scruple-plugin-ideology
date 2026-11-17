# scruple-plugin-ideology

A Scruple plugin enforcing the engineering ideology below as semantic lint rules.

## Philosophy

- **Effort Is the Enemy** — every line of code is a liability; so is every doc, meeting, and process
- **Simplicity Over Complexity** — simple is harder than complex; put in the work to save your future self
- **Separation of Concerns** — a place for everything, and everything in its place - applies whether you're splitting a monolith or a meeting agenda
- **Choose Deliberately** — actions chosen by omission, indecision, or assumption are still decisions, and they contain unknown consequences
- **80/20** — follow what you know works 80% of the time; let context override convention the other 20%
- **Not Everything Deserves Equal Effort** — invest best thinking in the core; not every discussion or implementation deserves effort
- **Deliver Value as Often as Possible** — small, verifiable increments
- **Deliver Value as Soon as Possible** — close the gap between writing code and proving it in context; make choices that lead to earlier delivery
- **Avoid Brittle Everything** — resilience comes from simplicity and loose coupling; applies to code, docs, processes, and architectures

## Ideals

- [Functional Programming](docs/ideologies/functional-programming.md) - Steal the easy stuff: Purity, composition, and declarative transformations
- [Agnostic Core](docs/ideologies/agnostic-core.md) - Keep business logic free of infrastructure concerns
- [Testing](docs/ideologies/testing.md) - Test behavior, not code
- [Codebase](docs/ideologies/codebase.md) - Code, dependencies, and configuration
- [Error Handling](docs/ideologies/error-handling.md) - Let errors bubble up, handle at the top
- [Outbound Call Resilience](docs/ideologies/outbound-call-resilience.md) - External failures are the normal path: bound every call, choose degradation deliberately

## Install

```
npm install --save-dev @scruple/cli @scruple/core @scruple/parser-oxc github:jaypeeZero/scruple-plugin-ideology#v0.3.0 github:jaypeeZero/scruple-provider-claude-cli
```

- The rules' thresholds are calibrated against Haiku 5.5 through [scruple-provider-claude-cli](https://github.com/jaypeeZero/scruple-provider-claude-cli).
- `scruple-provider-claude-cli` answers through the logged-in `claude` CLI, so no API key is needed.

```ts
// scruple.config.ts
import { defineConfig } from '@scruple/core'
import { oxcParser } from '@scruple/parser-oxc'
import { ideology } from 'scruple-plugin-ideology'
import { claudeCliProvider } from 'scruple-provider-claude-cli'

export default defineConfig({
  parser: oxcParser(),
  provider: claudeCliProvider(),
  include: ['src/**/*.ts'],
  plugins: { ideology: ideology() },
  rules: {
    'ideology/inject-dependencies': 'warn',
    'ideology/model-absence': 'warn',
    'ideology/no-argument-mutation': 'warn',
    'ideology/no-decisions-by-omission': 'warn',
    'ideology/no-hardcoded-config': 'warn',
    'ideology/no-hidden-state': 'warn',
    'ideology/no-infrastructure-in-core': 'warn',
    'ideology/no-repeated-literals': 'warn',
    'ideology/no-speculative-code': 'warn',
    'ideology/no-swallowed-errors': 'warn',
    'ideology/no-vendor-types-in-core': 'warn',
    'ideology/one-job-per-function': 'warn',
    'ideology/outbound-call-resilience': 'warn',
    'ideology/prefer-composition': 'warn',
    'ideology/prefer-declarative-transformation': 'warn',
    'ideology/prefer-simple-construct': 'warn',
    'ideology/translate-at-boundary': 'warn'
  }
})
```

## Running against a repo without changing it

- Scruple installs into a `.scruple/` folder at the target repo's root, holding its own `package.json`, `scruple.config.ts`, and `node_modules`.
- `.scruple/package.json` lists the packages from [Install](#install) as `dependencies`.
- `/.scruple/` goes in the target repo's `.git/info/exclude`, which git never commits, so `git status` stays clean.
- The CLI scans the directory it runs in, so the same install scans the repo or any of its worktrees.

```sh
# from the repo root
.scruple/node_modules/.bin/scruple -c .scruple/scruple.config.ts

# from a worktree
/path/to/repo/.scruple/node_modules/.bin/scruple -c /path/to/repo/.scruple/scruple.config.ts
```

A local build of this plugin installs into `.scruple` as a `file:` dependency, copied with `--install-links`. A plugin change reaches `.scruple` only after a rebuild and a fresh copy:

```sh
npm run build
rm -rf /path/to/repo/.scruple/node_modules/scruple-plugin-ideology
npm install --install-links --prefix /path/to/repo/.scruple
```

## Rules

| Rule id | Line enforced |
|---|---|
| `inject-dependencies` | Inject dependencies. Never instantiate or import a dependency internally. |
| `model-absence` | Model absence, don't default it. |
| `no-argument-mutation` | Do not mutate inputs; return a new value instead. |
| `no-decisions-by-omission` | Actions chosen by omission, indecision, or assumption are still decisions, and they contain unknown consequences. |
| `no-hardcoded-config` | Store config in environment variables. Never hardcode credentials. |
| `no-hidden-state` | Pure functions, explicit inputs, no hidden state. |
| `no-infrastructure-in-core` | Business logic in the core; infrastructure at the edges. Dependencies point inward. |
| `no-repeated-literals` | If a change in one place requires updates in many others, the number of required updates always grows. Anything referenced in more than one place is a constant, never a repeated magic string. |
| `no-speculative-code` | Every line of code is a liability. Write the minimum that delivers the behavior; if something can be deleted, delete it. |
| `no-swallowed-errors` | Errors bubble up. Only catch when recovery is possible and the rest can still run. |
| `no-vendor-types-in-core` | Backing services are attached resources. Swap any service by changing config, no code changes. |
| `one-job-per-function` | Each function, class, module, and layer has one obvious job. If it does too much, split it. |
| `outbound-call-resilience` | Failures from external services are the normal path, not edge cases. Design for degraded states, timeouts, and partial failures as first-class concerns. |
| `prefer-composition` | Small, focused functions combine into complex transformations. Compose functionality. |
| `prefer-declarative-transformation` | Declarative transformations over imperative loops. |
| `prefer-simple-construct` | Never choose a clever solution when a simple one handles the same requirement. |
| `translate-at-boundary` | Translate external formats at boundaries, not in core logic. |

## Options

### Shared options

| Option | Default | Rules |
|---|---|---|
| `threshold` | `{ warning: 0.75, error: 0.95 }` | every rule |
| `minConfidence` | `0.7` | every rule |
| `testFilePattern` | `(\.(spec\|test)\|[Ff]akes?\|[Dd]oubles?\|[Mm]ocks?\|[Ss]tubs?)\.[cm]?[jt]sx?$` | every rule |
| `compositionRootPattern` | `(^\|/)index\.[cm]?[jt]sx?$` | `inject-dependencies`, `no-hardcoded-config`, `no-infrastructure-in-core`, `no-vendor-types-in-core` |
| `infrastructureImportPatterns` | `['^node:(fs\|http\|https\|net\|child_process\|dgram)', '^(pg\|mysql2?\|mongodb\|mongoose\|ioredis\|redis\|kafkajs\|amqplib\|knex\|prisma\|@prisma/client\|typeorm\|sequelize\|drizzle-orm)$', '^@aws-sdk/', '^aws-sdk$', '^(axios\|got\|node-fetch\|undici\|ky)$', '^(express\|fastify\|koa\|hono\|@nestjs/)', '^(nodemailer\|twilio\|stripe\|@stripe/\|@sendgrid/)']` | `no-infrastructure-in-core`, `no-vendor-types-in-core` |

### Rule-specific options

| Rule | Option | Default |
|---|---|---|
| `inject-dependencies` | `factoryCallPatterns` | `['\.create$', '^create[A-Z]', '^make[A-Z]', '^connect$']` |
| `no-argument-mutation` | `mutatingMethodPatterns` | `['^(push\|pop\|shift\|unshift\|splice\|sort\|reverse\|fill\|copyWithin\|set\|delete\|clear\|add)$']` |
| `no-hardcoded-config` | `configLiteralPatterns` | `['^[a-z][a-z0-9+.-]*://', '\b(localhost\|127\.0\.0\.1)\b', '^(sk\|pk\|ghp\|xox[abp]\|AKIA)[A-Za-z0-9_-]{8,}', '\b[A-Za-z0-9._-]+\.(com\|net\|org\|io\|dev\|internal\|local)\b', '^(postgres\|mysql\|mongodb\|redis\|amqp\|kafka)']` |
| `no-hardcoded-config` | `configNamePatterns` | `['(apiKey\|api_key\|secret\|token\|password\|passwd\|connectionString\|databaseUrl\|bucket\|queue\|topic\|region\|host\|port)']` |
| `no-repeated-literals` | `minFunctions` | `2` |
| `no-repeated-literals` | `minLength` | `2` |
| `no-repeated-literals` | `ignoredLiteralPatterns` | `['^$', '^[01]$', '^-1$', '^\s*$', '^[.,;:!?()\[\]{}/\\-]$', '^\n$']` |
| `no-speculative-code` | `optionsParameterPatterns` | `['^(options\|opts\|config\|settings\|params)$']` |
| `one-job-per-function` | `minLines` | `40` |
| `one-job-per-function` | `ioCallPatterns` | `['^(fetch\|axios\|got)\b', '\.(query\|execute\|find\w*\|save\|insert\|update\|delete\|put\w*\|get\w*Object\|send\|publish\|subscribe\|readFile\w*\|writeFile\w*\|connect)$']` |
| `one-job-per-function` | `presentationCallPatterns` | `['^(console\|logger\|log)\.', '\.(toFixed\|toLocale\w+\|padStart\|padEnd\|format\|render)$']` |
| `one-job-per-function` | `validationCallPatterns` | `['\.(validate\|assert\w*\|check\w*\|is[A-Z]\w*)$', '^(assert\|invariant\|z\.\|yup\.\|joi\.)']` |
| `outbound-call-resilience` | `outboundCallPatterns` | `['^(fetch\|axios\|got\|ky\|undici)\b']` |
| `outbound-call-resilience` | `resiliencePatterns` | `['\b(\w*(timeout\|Timeout\|TIMEOUT)\w*\|signal\|AbortSignal\|AbortController\|retry\|retries\|maxAttempts\|backoff\|circuit\|fallback\|deadline)\b', 'Promise\.(race\|any\|allSettled)\b', '\.timeout\(']` |
| `prefer-composition` | `minSteps` | `3` |
| `prefer-composition` | `minNesting` | `4` |
| `prefer-composition` | `minChain` | `5` |
| `prefer-declarative-transformation` | `effectCallPatterns` | `['\.forEach$']` |
| `translate-at-boundary` | `parseCallPatterns` | `['^JSON\.parse$', '^parseInt$', '^parseFloat$', '^Number$', '^Date\.parse$', '\.split$', '\.validate(Async)?$', '\.parse$']` |
| `translate-at-boundary` | `externalShapePatterns` | `['\b(payload\|query\|headers\|params\|body\|statusCode)\b', '\breq(uest)?\.', '\bres(ponse)?\.(data\|body)\b', '\brow(s)?\b']` |

## Shared behaviours

- Every rule walks top-level functions only, except `no-swallowed-errors`, which walks catch blocks.
- Every rule scopes by code content, never by directory layout.
- An approved exception is recorded at the site, not in configuration:

```ts
// scruple-disable-next-line ideology/no-hidden-state -- module-level cache is a deliberate exception
```

## Caching decisions

Caching lives in [scruple-provider-cache](https://github.com/jaypeeZero/scruple-provider-cache), which wraps any `DecisionProvider`. Install it alongside this plugin.

## Evals

- `evals/` holds expected-label fixtures in Scruple's own fixture format.
- `npm run eval` runs every fixture live against Haiku 5.5 through the logged-in `claude` CLI.
- Evals are never cached.
- `npm run eval` is a report, not a test: it always exits 0.
- Each fixture line reads `right` or `WRONG`, with each candidate's margin: the probability of the rule's finding label minus the warning threshold.
- The last line counts the fixtures answered right and the fixtures with a margin within 0.05 of the threshold, which can flip between runs.
- What each rule collects is tested deterministically by `npm test`, not here.

## Development

```
npm install
npm test
npm run typecheck
npm run lint
```
