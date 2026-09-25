import { definePlugin } from '@scruple/core'
import { injectDependencies } from './rules/injectDependencies.ts'
import { modelAbsence } from './rules/modelAbsence.ts'
import { noHiddenState } from './rules/noHiddenState.ts'
import { preferDeclarativeTransformation } from './rules/preferDeclarativeTransformation.ts'
import { translateAtBoundary } from './rules/translateAtBoundary.ts'

export const ideology = () =>
  definePlugin({
    rules: {
      'inject-dependencies': injectDependencies,
      'model-absence': modelAbsence,
      'no-hidden-state': noHiddenState,
      'prefer-declarative-transformation': preferDeclarativeTransformation,
      'translate-at-boundary': translateAtBoundary
    }
  })
