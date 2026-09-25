
# Functional Programming Principles

We don't enforce a functional programming paradigm. We steal what works from it.

## Purity

```
    PURE                           IMPURE
    ────                           ──────
   ┌─────────┐                   ┌─────────┐
   │         │                   │         │◄──── global state
 ──┤  f(x)   ├──►                │  f(x)   │
   │         │                   │         ├────► side effects
   └─────────┘                   └─────────┘

 Same input = Same output       Who knows?
```

- **Produce output only from input** - Do not rely on hidden context, prior conversation, or undeclared state
- **Do not mutate inputs** - Treat all provided data as immutable; if transformation is needed, return a new value
- **Never introduce side effects** - Do not perform actions that alter external state (files, globals, external systems) unless explicitly instructed
- **Maintain referential transparency** - For identical inputs, always return identical outputs

```python
# ✗ Impure - mutates input, uses external state
tax_rate = 0.1
def add_tax(prices):
    for i in range(len(prices)):
        prices[i] *= (1 + tax_rate)

# ✓ Pure - new output from explicit input
def add_tax(prices, tax_rate):
    return [p * (1 + tax_rate) for p in prices]
```

## Composition

```
  f(x)          g(x)              g(f(x))
 ┌─────┐       ┌─────┐           ┌─────────────┐
 │ A→B │   +   │ B→C │     =     │    A→C      │
 └─────┘       └─────┘           └─────────────┘

 Small, focused functions combine into complex transformations
```

- **Prefer expression-based reasoning** - Construct answers as expressions that evaluate to values, not imperative sequences of steps
- **Use pure helper functions conceptually** - When breaking down a problem, imagine smaller pure functions whose only role is transforming input to output
- **Compose functionality** - Build complex solutions by combining smaller, independent logical transformations

```python
# Small, pure functions
def parse(s):    return int(s)
def double(n):   return n * 2
def to_string(n): return f"Result: {n}"

# Composed
def process(s):  return to_string(double(parse(s)))

# Or piped
process = parse(s)
  |> double
  |> to_string
```

## State Management

```
  EXPLICIT                        IMPLICIT
  ────────                        ────────
  ┌─────────────────┐            ┌─────────────────┐
  │ {                │            │                 │
  │   user: {...},   │            │     f(x)        │ ← reads config?
  │   config: {...}  │───►f(x)    │                 │ ← session state?
  │ }                │            │                 │ ← who knows?
  └─────────────────┘            └─────────────────┘

  Everything needed is passed     Hidden dependencies
```

- **Avoid implicit assumptions** - Any data needed for reasoning must appear explicitly in the input
- **Avoid global or persistent memory** - Do not depend on prior instructions unless they are explicitly passed in the current prompt
- **Avoid shared mutable state** - Do not imagine or create external state that changes over time
- **Model optional or missing data explicitly** - Represent absence conceptually as Option/Maybe rather than assuming defaults

```python
# ✗ Implicit - assumes user exists, uses global
def get_greeting():
    return f"Hello, {current_user.name}"

# ✓ Explicit - all inputs declared, absence modeled
def get_greeting(user):
    return f"Hello, {user.name}" if user else "Hello, guest"
```

## Transformation

```
  DECLARATIVE                     IMPERATIVE
  ───────────                     ──────────

  results = [u.email              results = []
    for u in users                for u in users:
    if u.active]                      if u.active:
                                          results.append(u.email)

  ↓                               ↓
  What we want                    How to do it step by step
```

- **Favor mapping, folding, filtering, and recursion** - When transforming collections or repeated structures, apply uniform transformations rather than stepwise mutation
- **Ensure deterministic transformations** - The reasoning should not contain randomness unless explicitly asked for
- **Choose declarative over imperative** - Describe what the transformation is, not a sequence of actions to perform
- **Idempotence where possible** - Re-running the same logical transformation must yield the same structure and meaning

```python
# Declarative transformations
active_emails = [u.email for u in users if u.active]

active_emails = users.filter(u => u.active).map(u => u.email)

total = sum(item.price for item in items)

grouped = group_by(items, key=u => u.category)
```
