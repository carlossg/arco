/**
 * Simple (synchronous, in-memory) RAG steps — products, features, FAQs,
 * reviews. Each fetches from bundled content metadata, slices to a configured
 * maximum, and writes to ctx.rag[<key>].
 *
 * Previously each step had its own ~14-line file that was nearly identical
 * boilerplate. The factory below removes that duplication.
 */

import {
  getRelevantProducts,
  getRelevantFeatures,
  getRelevantFaqs,
  getRelevantReviews,
} from '../../context.js';

/**
 * Build a RAG step that fetches a list, slices it, and records a timing.
 *
 * @param {object}   spec
 * @param {string}   spec.key         ctx.rag key to write (also used for ctx.timings)
 * @param {number}   spec.defaultMax  Slice size when config.maxResults not set
 * @param {Function} spec.fetch       (ctx) => Array — performs the retrieval
 * @returns {(ctx: object, config?: object, env?: object) => Promise<void>}
 */
function createSlicingStep({ key, defaultMax, fetch }) {
  return async (ctx, config = {}) => {
    const start = Date.now();
    const results = fetch(ctx) || [];
    ctx.rag[key] = results.slice(0, config.maxResults || defaultMax);
    ctx.timings[key] = Date.now() - start;
  };
}

export const ragProducts = createSlicingStep({
  key: 'products',
  defaultMax: 8,
  fetch: (ctx) => getRelevantProducts(
    ctx.request.query,
    ctx.rag.persona,
    ctx.rag.useCase,
    ctx.request.shownContent?.shownProducts || [],
  ),
});

export const ragFeatures = createSlicingStep({
  key: 'features',
  defaultMax: 6,
  fetch: (ctx) => getRelevantFeatures(ctx.request.query, ctx.rag.products),
});

export const ragFaqs = createSlicingStep({
  key: 'faqs',
  defaultMax: 4,
  fetch: (ctx) => getRelevantFaqs(ctx.request.query),
});

export const ragReviews = createSlicingStep({
  key: 'reviews',
  defaultMax: 6,
  fetch: (ctx) => getRelevantReviews(ctx.request.query, ctx.rag.products),
});
