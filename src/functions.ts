import type { FunctionTarget, ParsedDocument } from '@scruple/core'

// A method is its own top-level function relative to its sibling methods; only a
// function whose range sits inside another function's body (a nested declaration,
// a callback) is excluded, so every rule walks real call sites once each.
const isNestedWithin = (candidate: FunctionTarget, other: FunctionTarget): boolean =>
  candidate !== other && other.range.start <= candidate.range.start && other.range.end >= candidate.range.end

export const topLevelFunctions = (document: ParsedDocument): FunctionTarget[] =>
  document.functions.filter((fn) => !document.functions.some((other) => isNestedWithin(fn, other)))
