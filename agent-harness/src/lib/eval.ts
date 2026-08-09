// -------------------------------------------------------------------------- //
//                                    EVAL                                    //
// -------------------------------------------------------------------------- //

import type { EvalCase } from "./types.js";

export function resolveEvalCasePaths(
  candidateCase: EvalCase,
  explicitPaths: string[],
  fallbackPaths: string[],
): string[] {
  if (explicitPaths.length > 0) {
    return [...new Set(explicitPaths)].sort();
  }

  if (candidateCase.evaluation_paths && candidateCase.evaluation_paths.length > 0) {
    return [...new Set(candidateCase.evaluation_paths)].sort();
  }

  return [...new Set(fallbackPaths)].sort();
}
