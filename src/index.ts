import { definePlugin } from '@scruple/core'
import { injectDependencies } from './rules/injectDependencies.ts'
import { modelAbsence } from './rules/modelAbsence.ts'
import { noArgumentMutation } from './rules/noArgumentMutation.ts'
import { noDecisionsByOmission } from './rules/noDecisionsByOmission.ts'
import { noHardcodedConfig } from './rules/noHardcodedConfig.ts'
import { noHiddenState } from './rules/noHiddenState.ts'
import { noSwallowedErrors } from './rules/noSwallowedErrors.ts'
import { preferDeclarativeTransformation } from './rules/preferDeclarativeTransformation.ts'
import { translateAtBoundary } from './rules/translateAtBoundary.ts'

export const ideology = () =>
  definePlugin({
    rules: {
      'inject-dependencies': injectDependencies,
      'model-absence': modelAbsence,
      'no-argument-mutation': noArgumentMutation,
      'no-decisions-by-omission': noDecisionsByOmission,
      'no-hardcoded-config': noHardcodedConfig,
      'no-hidden-state': noHiddenState,
      'no-swallowed-errors': noSwallowedErrors,
      'prefer-declarative-transformation': preferDeclarativeTransformation,
      'translate-at-boundary': translateAtBoundary
    }
  })
