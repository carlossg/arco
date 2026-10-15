/**
 * Select Layout Step — fast-path structured decision for the primary content
 * shape of the generated page, using TypeSafe AI's Jev (System One) model.
 *
 * This is additive, not a replacement: the `llm-generate` step still decides
 * every block freely from the full JSON block schema (see
 * prompts/partials/block-guide.njk). When Jev returns a confident answer, we
 * inject it into the prompt as a *hint* the model is told it may follow.
 * When Jev is unavailable, errors, times out, or returns low confidence,
 * ctx.layoutHint stays null and generation is byte-identical to before this
 * step existed.
 *
 * Writes ctx.layoutHint = { choice, confidence, probabilities } | null.
 */

import { askChoice } from '../../jev-client.js';

const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

const LAYOUT_CRITERIA = {
  'comparison-table': 'User is weighing 2+ specific products or asking which is better/different.',
  'single-recommendation': 'User wants one clear best pick for a stated need or use case.',
  'discovery-grid': 'User is browsing broadly with no single stated need — show a spread of options.',
  'editorial-verdict': 'User wants a direct answer, explanation, or verdict rather than a list of products.',
};

// eslint-disable-next-line import/prefer-default-export, no-unused-vars
export async function selectLayout(ctx, config = {}, env = {}) {
  const start = Date.now();
  ctx.layoutHint = null;

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
