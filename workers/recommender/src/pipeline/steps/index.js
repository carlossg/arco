/**
 * Step Registry — imports all pipeline steps and exports the STEPS map.
 */

import { rateLimit } from './rate-limit.js';
import { safetyGate } from './safety-gate.js';
import { intentClassify } from './intent-classify.js';
import { personaMatch } from './persona-match.js';
import { useCaseMatch } from './use-case-match.js';
import {
  ragProducts, ragFeatures, ragFaqs, ragReviews,
} from './rag-simple.js';
import { ragContent } from './rag-content.js';
import { llmGenerate } from './llm-generate.js';
import { analyzeBehavior } from './analyze-behavior.js';
import { buildRecommenderPrompt } from './build-recommender-prompt.js';

/**
 * Step function map — keys match the "step" field in flow configs.
 * Every step implements the same contract: async (ctx, config = {}, env = {}) => void
 * Steps that ignore config or env still accept them so the executor can call
 * them uniformly.
 */
// eslint-disable-next-line import/prefer-default-export
export const STEPS = {
  'rate-limit': rateLimit,
  'safety-gate': safetyGate,
  'intent-classify': intentClassify,
  'persona-match': personaMatch,
  'use-case-match': useCaseMatch,
  'rag-products': ragProducts,
  'rag-features': ragFeatures,
  'rag-faqs': ragFaqs,
  'rag-reviews': ragReviews,
  'rag-content': ragContent,
  'llm-generate': llmGenerate,
  'analyze-behavior': analyzeBehavior,
  'build-recommender-prompt': buildRecommenderPrompt,
};
