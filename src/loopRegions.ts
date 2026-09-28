import type { ControlRegionFact, FunctionTarget, ParsedDocument } from '@scruple/core'

// A loop region belongs to a function when its range sits inside that function's
// range. Shared so every rule that must agree on "this function contains a loop" -
// to claim the loop, or, elsewhere, to leave a looping function alone - uses the
// same definition of containment.
export const loopRegionsWithin = (
  document: ParsedDocument,
  fn: FunctionTarget
): (ControlRegionFact & { kind: 'loop' })[] =>
  (document.facts?.controls ?? []).filter(
    (control): control is ControlRegionFact & { kind: 'loop' } =>
      control.kind === 'loop' && control.range.start >= fn.range.start && control.range.end <= fn.range.end
  )
