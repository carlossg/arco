/**
 * Build Recommender Prompt Step — assembles system and user prompts
 * for the Arco coffee equipment recommender.
 * Reads ctx.rag.*, ctx.request.*, ctx.intent. Writes ctx.prompt.system, ctx.prompt.user.
 */

import {
  buildRecommenderSystemPrompt,
  buildRecommenderUserMessage,
} from '../../recommender-prompt.js';

// eslint-disable-next-line import/prefer-default-export, no-unused-vars
export async function buildRecommenderPrompt(ctx, config = {}, env = {}) {
  const start = Date.now();

  ctx.prompt.system = buildRecommenderSystemPrompt();

  const contextData = {
    products: ctx.rag.products,
    guides: ctx.rag.guides,
    experiences: ctx.rag.experiences,
    features: ctx.rag.features,
    faqs: ctx.rag.faqs,
    reviews: ctx.rag.reviews,
    recipes: ctx.rag.recipes,
    comparisons: ctx.rag.comparisons,
    toolContent: ctx.rag.toolContent,
    persona: ctx.rag.persona,
    useCase: ctx.rag.useCase,
  };

  ctx.prompt.user = buildRecommenderUserMessage(
    ctx.request.query,
    ctx.rag.behaviorAnalysis,
    ctx.request.previousQueries,
    ctx.request.followUp,
    ctx.request.shownContent,
    ctx.intent,
    contextData,
    { tv: ctx.tv === true },
  );

  // Jev fast-path hint (see select-layout.js) — advisory only, appended as
  // plain text so a low-confidence/unavailable Jev call leaves the prompt
  // byte-identical to before this feature existed.
  if (ctx.layoutHint) {
    ctx.prompt.user += `\n\nSuggested content shape (advisory, confidence ${ctx.layoutHint.confidence.toFixed(2)}): ${ctx.layoutHint.choice}. Use this as a hint for which block type to lead with after the hero, but prioritize your own judgment of the query and available content.`;
  }

  ctx.timings.prompt = Date.now() - start;
}
