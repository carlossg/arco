/**
 * RAG Reviews Step — retrieves relevant product reviews.
 * Reads ctx.rag.products. Writes ctx.rag.reviews.
 */

import { getRelevantReviews } from '../../context.js';

// eslint-disable-next-line import/prefer-default-export
export async function ragReviews(ctx, config) {
  const start = Date.now();
  const results = getRelevantReviews(ctx.request.query, ctx.rag.products);
  ctx.rag.reviews = results.slice(0, config.maxResults || 6);
  ctx.timings.reviews = Date.now() - start;
}
