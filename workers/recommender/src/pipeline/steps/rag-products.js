/**
 * RAG Products Step — scores and retrieves relevant products.
 * Reads ctx.rag.persona, ctx.rag.useCase. Writes ctx.rag.products.
 */

import { getRelevantProducts } from '../../context.js';

// eslint-disable-next-line import/prefer-default-export
export async function ragProducts(ctx, config) {
  const start = Date.now();
  const results = getRelevantProducts(ctx.request.query, ctx.rag.persona, ctx.rag.useCase);
  ctx.rag.products = results.slice(0, config.maxResults || 8);
  ctx.timings.products = Date.now() - start;
}
