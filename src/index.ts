import { definePlugin } from '@scruple/core'
import { injectDependencies } from './rules/injectDependencies.ts'
import { modelAbsence } from './rules/modelAbsence.ts'
import { noArgumentMutation } from './rules/noArgumentMutation.ts'
import { noDecisionsByOmission } from './rules/noDecisionsByOmission.ts'
import { noHardcodedConfig } from './rules/noHardcodedConfig.ts'
import { noHiddenState } from './rules/noHiddenState.ts'
import { noInfrastructureInCore } from './rules/noInfrastructureInCore.ts'
import { noRepeatedLiterals } from './rules/noRepeatedLiterals.ts'
import { noSpeculativeCode } from './rules/noSpeculativeCode.ts'
import { noSwallowedErrors } from './rules/noSwallowedErrors.ts'
import { oneJobPerFunction } from './rules/oneJobPerFunction.ts'
import { preferComposition } from './rules/preferComposition.ts'
import { preferDeclarativeTransformation } from './rules/preferDeclarativeTransformation.ts'
import { preferSimpleConstruct } from './rules/preferSimpleConstruct.ts'
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
      'no-infrastructure-in-core': noInfrastructureInCore,
      'no-repeated-literals': noRepeatedLiterals,
      'no-speculative-code': noSpeculativeCode,
      'no-swallowed-errors': noSwallowedErrors,
      'one-job-per-function': oneJobPerFunction,
      'prefer-composition': preferComposition,
      'prefer-declarative-transformation': preferDeclarativeTransformation,
      'prefer-simple-construct': preferSimpleConstruct,
      'translate-at-boundary': translateAtBoundary
    }
  })
