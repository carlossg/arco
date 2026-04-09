/**
 * RAG Features Step — retrieves relevant product features.
 * Reads ctx.rag.products. Writes ctx.rag.features.
 */

import { getRelevantFeatures } from '../../context.js';

// eslint-disable-next-line import/prefer-default-export
export async function ragFeatures(ctx, config) {
  const start = Date.now();
  const results = getRelevantFeatures(ctx.request.query, ctx.rag.products);
  ctx.rag.features = results.slice(0, config.maxResults || 6);
  ctx.timings.features = Date.now() - start;
}
