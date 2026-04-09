/**
 * RAG FAQs Step — retrieves relevant FAQs by keyword matching.
 * Writes ctx.rag.faqs.
 */

import { getRelevantFaqs } from '../../context.js';

// eslint-disable-next-line import/prefer-default-export
export async function ragFaqs(ctx, config) {
  const start = Date.now();
  const results = getRelevantFaqs(ctx.request.query);
  ctx.rag.faqs = results.slice(0, config.maxResults || 4);
  ctx.timings.faqs = Date.now() - start;
}
