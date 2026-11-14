/**
 * Select Layout Step — fast-path structured decision for the primary content
 * shape of the generated page, using Gemini Decisions or TypeSafe AI's Jev.
 *
 * This is additive, not a replacement: the `llm-generate` step still decides
 * every block freely from the full JSON block schema (see
 * prompts/partials/block-guide.njk). When the provider returns a confident answer, we
 * inject it into the prompt as a *hint* the model is told it may follow.
 * When Jev is unavailable, errors, times out, or returns low confidence,
 * ctx.layoutHint stays null and generation is byte-identical to before this
 * step existed.
 *
 * Writes ctx.layoutHint = { choice, confidence, probabilities } | null.
 */

import { askChoice } from '../../jev-client.js';
import { layoutProvider } from '../../decisions.js';
import { LAYOUT_CRITERIA } from './classify-decisions.js';

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

// eslint-disable-next-line import/prefer-default-export, no-unused-vars
export async function selectLayout(ctx, config = {}, env = {}) {
  const start = Date.now();
  ctx.layoutHint = null;
  const provider = layoutProvider(env);
  if (ctx.tv || provider === 'off') {
    ctx.timings.selectLayout = Date.now() - start;
    return;
  }
  if (provider === 'gemini') {
    const answer = ctx.decisions?.answers?.layout;
    if (ctx.decisions?.layoutMode === 'on'
      && answer?.confidence >= ctx.decisions.threshold) {
      ctx.layoutHint = { ...answer, model: ctx.decisions.model };
    }
    ctx.timings.selectLayout = Date.now() - start;
    return;
  }

  const apiKey = env.TYPESAFE_API_KEY;
  if (!apiKey) {
    ctx.timings.selectLayout = Date.now() - start;
    return;
  }

  const threshold = config.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  const answer = await askChoice({
    apiKey,
    state: {
      query: ctx.request.query,
      previousQueries: ctx.request.previousQueries,
      isFollowUp: Boolean(ctx.request.followUp),
      intentType: ctx.intent?.type,
      journeyStage: ctx.intent?.journeyStage,
      shownBlockTypes: ctx.request.shownContent?.shownSections
        ?.map((s) => s.blockType) || [],
    },
    instructions: 'What primary content shape best fits the top of the generated page, right after the hero?',
    criteria: LAYOUT_CRITERIA,
    timeoutMs: config.timeoutMs,
  });

  if (answer && answer.confidence >= threshold) {
    ctx.layoutHint = answer;
  }

  ctx.timings.selectLayout = Date.now() - start;
}
