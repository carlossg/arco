/**
 * RAG Content Step — unified guide + experience search via Vectorize.
 * Generates one embedding, queries CONTENT_INDEX, splits by metadata type.
 * Writes ctx.rag.guides and ctx.rag.experiences.
 */

import { searchContent } from '../../context.js';

// eslint-disable-next-line import/prefer-default-export
export async function ragContent(ctx, config, env) {
  const start = Date.now();
  const { guides, experiences, timings } = await searchContent(ctx.request.query, env, config);
  ctx.rag.guides = guides;
  ctx.rag.experiences = experiences;
  ctx.timings.guidesMs = timings.guidesMs;
  ctx.timings.experiencesMs = timings.experiencesMs;
  ctx.timings.contentDetail = timings;
  ctx.timings.content = Date.now() - start;
}
