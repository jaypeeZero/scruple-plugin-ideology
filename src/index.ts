import { definePlugin } from '@scruple/core'
import { injectDependencies } from './rules/injectDependencies.ts'
import { modelAbsence } from './rules/modelAbsence.ts'
import { noArgumentMutation } from './rules/noArgumentMutation.ts'
import { noHiddenState } from './rules/noHiddenState.ts'
import { preferDeclarativeTransformation } from './rules/preferDeclarativeTransformation.ts'
import { translateAtBoundary } from './rules/translateAtBoundary.ts'

export const ideology = () =>
  definePlugin({
    rules: {
      'inject-dependencies': injectDependencies,
      'model-absence': modelAbsence,
      'no-argument-mutation': noArgumentMutation,
      'no-hidden-state': noHiddenState,
      'prefer-declarative-transformation': preferDeclarativeTransformation,
      'translate-at-boundary': translateAtBoundary
    }
  })
