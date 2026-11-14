/**
 * Use Case Match Step — matches query against use case definitions.
 * Writes ctx.rag.useCase.
 */

import { matchUseCase, getUseCaseBySlug } from '../../context.js';
import { acceptedDecision } from '../../decisions.js';

// eslint-disable-next-line import/prefer-default-export, no-unused-vars
export async function useCaseMatch(ctx, config = {}, env = {}) {
  const start = Date.now();
  const baseline = matchUseCase(ctx.request.query);
  const answer = acceptedDecision(ctx, 'useCase');
  ctx.rag.useCase = answer ? getUseCaseBySlug(answer.choice) : baseline;
  if (ctx.decisions) ctx.decisions.baselineUseCase = baseline?.slug || null;
  ctx.timings.useCase = Date.now() - start;
}
