/**
 * Use Case Match Step — matches query against use case definitions.
 * Writes ctx.rag.useCase.
 */

import { matchUseCase } from '../../context.js';

// eslint-disable-next-line import/prefer-default-export
export async function useCaseMatch(ctx) {
  const start = Date.now();
  ctx.rag.useCase = matchUseCase(ctx.request.query);
  ctx.timings.useCase = Date.now() - start;
}
