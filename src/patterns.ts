// Matched against a single value (a callee name), so a plain, non-global test suffices.
export const matchesAny = (patterns: RegExp[], value: string): boolean =>
  patterns.some((pattern) => pattern.test(value))
