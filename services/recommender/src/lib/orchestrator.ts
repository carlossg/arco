/**
 * Orchestrator — Main Pipeline for the Arco Recommender
 *
 * Coordinates the full recommendation pipeline:
 *   1. Fast Classification  (Gemini Flash)  — classify user intent
 *   2. Deep Reasoning       (Gemini Pro)    — select blocks & explain thinking
 *   3. Content Generation   (Gemini Pro)    — generate block HTML in parallel
 *   4. HTML Assembly                        — build DA-compliant AEM EDS markup
 *   5. SSE Streaming                        — stream blocks to the client
 *
 * All product data, prices, specs, and images come from the content service
 * (RAG context). The LLM is instructed never to hallucinate product details.
 */

import type {
  Env,
  IntentClassification,
  IntentType,
  SessionContext,
  ReasoningResult,
  BlockSelection,
  SSEEvent,
  BlockType,
  JourneyStage,
  BrowsingHistoryItem,
  InferredBrowsingProfile,
} from '../types';
import {
  createGoogleModelFactory as createModelFactory,
  type Message,
  type GoogleModelFactory,
} from '../ai-clients/model-factory-google';
import {
  analyzeAndSelectBlocks,
  formatReasoningForDisplay,
} from '../ai-clients/reasoning-engine';
import {
  buildRAGContext,
  getProductById,
  getBrewGuideById,
  getAllProducts,
  getProductsByUseCase,
  getAllReviews,
  getFAQsForQuery,
  type RAGContext,
  type FAQ,
  type Product,
  type BrewGuide,
  type Review,
} from '../content/content-service';
import { selectHeroImage } from './hero-images';

/* ========================================================================== */
/*  Types                                                                      */
/* ========================================================================== */

interface OrchestrationContext {
  query: string;
  slug: string;
  intent?: IntentClassification;
  ragContext?: RAGContext;
  reasoningResult?: ReasoningResult;
  generatedBlocks?: GeneratedBlock[];
}

interface GeneratedBlock {
  type: string;
  html: string;
  sectionStyle?: string;
}

type SSECallback = (event: SSEEvent) => void;

/* ========================================================================== */
/*  Constants                                                                  */
/* ========================================================================== */

/** Canonical Arco model names used for entity extraction. */
const ARCO_MODEL_NAMES = [
  'primo', 'doppio', 'nano', 'studio', 'studio-pro',
  'ufficio', 'viaggio', 'automatico', 'filtro',
  'preciso', 'macinino', 'zero',
] as const;

/** Section style mappings for specific block types. */
const BLOCK_SECTION_STYLES: Record<string, string> = {
  hero: 'dark',
  'best-pick': 'highlight',
  testimonials: 'highlight',
  'budget-breakdown': 'highlight',
  'support-triage': 'highlight',
};

/* ========================================================================== */
/*  1. Fast Intent Classification (Gemini Flash)                               */
/* ========================================================================== */

const CLASSIFICATION_SYSTEM_PROMPT = `You are an intent classifier for the Arco coffee equipment recommendation system.
Classify user queries into intent types and extract entities.

Arco is a premium coffee equipment brand that makes espresso machines, grinders, and accessories.

Arco product model names: ${ARCO_MODEL_NAMES.join(', ')}

## Intent Types
- discovery: User is browsing or exploring the product line
- comparison: User wants to compare products
- product-detail: User asks about a specific product
- use-case: User describes a use case or scenario
- specs: User asks about specifications or technical details
- reviews: User asks about reviews or customer experiences
- price: User asks about pricing, value, or budget
- recommendation: User wants a personal recommendation
- support: User has a problem, warranty question, or issue
- gift: User is buying for someone else
- beginner: User is new to espresso or coffee equipment
- upgrade: User is upgrading from existing equipment
- technique: User asks about brewing technique, recipes, or methods

## Journey Stages
- exploring: Early research, broad questions, browsing
- comparing: Narrowing options, feature comparisons, trade-offs
- deciding: Ready to buy, final questions, confirmation seeking

## Instructions
Analyse the user query and return a JSON object (no markdown fences, no extra text):
{
  "intentType": "<one of the intent types above>",
  "confidence": <0.0 to 1.0>,
  "entities": {
    "products": ["<arco model names mentioned>"],
    "useCases": ["<use cases detected>"],
    "features": ["<features or specs mentioned>"]
  },
  "journeyStage": "<exploring | comparing | deciding>"
}

Extract ALL Arco model names if mentioned. Be generous with entity extraction.
If the user mentions competitor brands, still classify normally and note Arco products that are relevant.`;

/**
 * Formats browsing context (page visits and inferred profile) into a text
 * block suitable for inclusion in the classification prompt.
 */
function formatBrowsingContextForClassification(
  browsingHistory?: BrowsingHistoryItem[],
  inferredProfile?: InferredBrowsingProfile,
): string {
  const parts: string[] = ['## Browsing Context'];

  if (inferredProfile) {
    const profileLines: string[] = [];
    if (inferredProfile.productsViewed.length > 0) {
      profileLines.push(`- Products viewed: ${inferredProfile.productsViewed.join(', ')}`);
    }
    if (inferredProfile.categoriesViewed.length > 0) {
      profileLines.push(`- Categories browsed: ${inferredProfile.categoriesViewed.join(', ')}`);
    }
    if (inferredProfile.interests.length > 0) {
      profileLines.push(`- Interests/filters: ${inferredProfile.interests.join(', ')}`);
    }
    if (inferredProfile.quizAnswers && Object.keys(inferredProfile.quizAnswers).length > 0) {
      const answers = Object.values(inferredProfile.quizAnswers).join(', ');
      profileLines.push(`- Quiz answers: ${answers}`);
    }
    profileLines.push(`- Journey stage: ${inferredProfile.journeyStage}`);
    profileLines.push(`- Pages visited: ${inferredProfile.pagesVisited}`);
    if (inferredProfile.totalTimeOnSite > 0) {
      profileLines.push(`- Total time on site: ${inferredProfile.totalTimeOnSite}s`);
    }
    parts.push(profileLines.join('\n'));
  }

  if (browsingHistory && browsingHistory.length > 0) {
    const recentPages = browsingHistory.slice(-5);
    const pageLines = recentPages.map((p) => {
      const timeStr = p.timeSpent ? ` (${p.timeSpent}s)` : '';
      return `- Visited: ${p.path}${timeStr}`;
    });
    parts.push(`Recent pages:\n${pageLines.join('\n')}`);
  }

  return parts.join('\n');
}

/**
 * Classifies user intent using a fast model (Gemini Flash).
 * Provides conversational continuity when session context is available.
 */
export async function classifyIntent(
  query: string,
  sessionContext?: SessionContext,
  preset?: string,
  modelOverride?: string,
): Promise<IntentClassification> {
  const factory = createModelFactory(preset || modelOverride);

  // Build messages with optional session context
  const messages: Message[] = [
    { role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT },
  ];

  // Build context sections
  const contextSections: string[] = [];

  // Browsing context from passive signal collection
  if (sessionContext?.browsingHistory?.length || sessionContext?.inferredProfile) {
    contextSections.push(formatBrowsingContextForClassification(
      sessionContext.browsingHistory,
      sessionContext.inferredProfile,
    ));
  }

  // Recent conversation history for continuity
  if (sessionContext?.previousQueries?.length) {
    const recentQueries = sessionContext.previousQueries.slice(-3);
    const historyContext = recentQueries
      .map((q) => `- Previous query: "${q.query}" → intent: ${q.intent}, products: [${q.entities?.products?.join(', ') || ''}]`)
      .join('\n');
    contextSections.push(`## Conversation History\n${historyContext}`);
  }

  if (contextSections.length > 0) {
    messages.push({
      role: 'user',
      content: `${contextSections.join('\n\n')}\n\n## Current Query\n"${query}"\n\nClassify the current query considering all available context. Return JSON only.`,
    });
  } else {
    messages.push({
      role: 'user',
      content: `Classify this query: "${query}"\n\nReturn JSON only.`,
    });
  }

  try {
    const response = await factory.call('classification', messages);
    const parsed = parseJSONResponse<IntentClassification>(response.content);

    // Validate and normalise the response
    return normaliseIntentClassification(parsed, query);
  } catch (error) {
    console.error('[orchestrator] Intent classification failed, using fallback:', error);
    return fallbackClassifyIntent(query);
  }
}

/**
 * Normalises a parsed intent classification, ensuring all fields are valid.
 */
function normaliseIntentClassification(
  raw: Partial<IntentClassification>,
  query: string,
): IntentClassification {
  const validIntentTypes: IntentType[] = [
    'discovery', 'comparison', 'product-detail', 'use-case', 'specs',
    'reviews', 'price', 'recommendation', 'support', 'gift',
    'beginner', 'upgrade', 'technique',
  ];
  const validJourneyStages: JourneyStage[] = ['exploring', 'comparing', 'deciding'];

  // Validate intentType
  let intentType: IntentType = 'discovery';
  if (raw.intentType && validIntentTypes.includes(raw.intentType)) {
    intentType = raw.intentType;
  }

  // Validate journeyStage
  let journeyStage: JourneyStage = 'exploring';
  if (raw.journeyStage && validJourneyStages.includes(raw.journeyStage)) {
    journeyStage = raw.journeyStage;
  }

  // Validate confidence
  let confidence = 0.5;
  if (typeof raw.confidence === 'number' && raw.confidence >= 0 && raw.confidence <= 1) {
    confidence = raw.confidence;
  }

  // Extract and validate entities
  const products = Array.isArray(raw.entities?.products)
    ? raw.entities.products.filter((p): p is string => typeof p === 'string')
    : extractArcoModelsFromQuery(query);

  const useCases = Array.isArray(raw.entities?.useCases)
    ? raw.entities.useCases.filter((u): u is string => typeof u === 'string')
    : [];

  const features = Array.isArray(raw.entities?.features)
    ? raw.entities.features.filter((f): f is string => typeof f === 'string')
    : [];

  return {
    intentType,
    confidence,
    entities: { products, useCases, features },
    journeyStage,
  };
}

/**
 * Fallback intent classification using keyword rules when the LLM is unavailable.
 */
function fallbackClassifyIntent(query: string): IntentClassification {
  const lower = query.toLowerCase();
  const products = extractArcoModelsFromQuery(query);

  // Determine intent type from keywords
  let intentType: IntentType = 'discovery';
  let journeyStage: JourneyStage = 'exploring';

  if (/problem|broken|leaking|warranty|return|not working/i.test(lower)) {
    intentType = 'support';
    journeyStage = 'deciding';
  } else if (/compare|vs|versus|difference between|which is better|which one/i.test(lower)) {
    intentType = 'comparison';
    journeyStage = 'comparing';
  } else if (/first espresso|beginner|new to espresso|nespresso|switching from pods/i.test(lower)) {
    intentType = 'beginner';
    journeyStage = 'exploring';
  } else if (/gift|birthday|wedding|christmas/i.test(lower)) {
    intentType = 'gift';
    journeyStage = 'deciding';
  } else if (/upgrade|outgrown|step up|pod machine|better than/i.test(lower)) {
    intentType = 'upgrade';
    journeyStage = 'comparing';
  } else if (/budget|afford|cheap|worth it|price|how much|cost/i.test(lower)) {
    intentType = 'price';
    journeyStage = 'comparing';
  } else if (/review|testimonial|customer|experience|opinion/i.test(lower)) {
    intentType = 'reviews';
    journeyStage = 'comparing';
  } else if (/spec|technical|dimension|weight|boiler|pump|watt/i.test(lower)) {
    intentType = 'specs';
    journeyStage = 'comparing';
  } else if (/recipe|brew|technique|latte art|steam milk|grind size|dial in/i.test(lower)) {
    intentType = 'technique';
    journeyStage = 'exploring';
  } else if (/recommend|suggest|best for|which.*should|help.*choose/i.test(lower)) {
    intentType = 'recommendation';
    journeyStage = 'exploring';
  } else if (products.length === 1) {
    intentType = 'product-detail';
    journeyStage = 'comparing';
  } else if (/office|travel|home|commercial|restaurant|family/i.test(lower)) {
    intentType = 'use-case';
    journeyStage = 'exploring';
  }

  return {
    intentType,
    confidence: 0.4,
    entities: { products, useCases: [], features: [] },
    journeyStage,
  };
}

/**
 * Extracts Arco model names from a query string.
 */
function extractArcoModelsFromQuery(query: string): string[] {
  const lower = query.toLowerCase();
  const found: string[] = [];

  for (const model of ARCO_MODEL_NAMES) {
    const pattern = new RegExp(`\\b${model.replace('-', '\\s*-?\\s*')}\\b`, 'gi');
    if (pattern.test(lower) && !found.includes(model)) {
      found.push(model);
    }
  }

  return found;
}

/* ========================================================================== */
/*  2. Content Generation — Block HTML                                         */
/* ========================================================================== */

const CONTENT_GENERATION_SYSTEM_PROMPT = `You are a content generator for Arco, a premium coffee equipment brand.
Generate AEM Edge Delivery Services (EDS) compatible HTML blocks.

## Critical Rules
1. ONLY use product data (names, prices, specs, images) from the provided context. NEVER invent product details.
2. All blocks must follow AEM EDS markup conventions:
   <div class="blockname">
     <div><!-- row -->
       <div><!-- column --></div>
     </div>
   </div>
3. Use semantic HTML: proper headings (h1-h4), paragraphs, lists, links, images.
4. Links to products should use the product URL from the context data.
5. Follow-up suggestion links must use the format: <a href="/?q=encoded+query">suggestion text</a>
6. Prices must include the currency symbol and use the exact price from context.
7. Images must use the exact URLs from the product data or the provided hero image URL.
8. Keep content concise, helpful, and focused on the user's needs.
9. Write in a warm, knowledgeable tone — like a passionate barista helping a friend.

## Block Format Examples

### Hero Block
<div class="hero">
  <div>
    <div>
      <picture><img src="IMAGE_URL" alt="description"></picture>
    </div>
    <div>
      <h1>Headline</h1>
      <p>Subtitle or description</p>
      <p><a href="/products/">Explore Machines</a></p>
    </div>
  </div>
</div>

### Cards Block
<div class="cards">
  <div>
    <div><picture><img src="IMAGE_URL" alt="Product Name"></picture></div>
    <div>
      <h3>Product Name</h3>
      <p>Description</p>
      <p><strong>$X,XXX</strong></p>
      <p><a href="/products/product-url/">Learn More</a></p>
    </div>
  </div>
  <!-- repeat for each card -->
</div>

### Comparison Table Block
<div class="comparison-table">
  <div>
    <div><strong>Feature</strong></div>
    <div><strong>Product A</strong></div>
    <div><strong>Product B</strong></div>
  </div>
  <div>
    <div>Price</div>
    <div>$X,XXX</div>
    <div>$Y,YYY</div>
  </div>
  <!-- repeat for each spec row -->
</div>

### Accordion Block (FAQ)
<div class="accordion">
  <div>
    <div><h3>Question text?</h3></div>
    <div><p>Answer text.</p></div>
  </div>
  <!-- repeat for each Q&A -->
</div>

### Best Pick Block
<div class="best-pick">
  <div>
    <div><picture><img src="IMAGE_URL" alt="Product Name"></picture></div>
    <div>
      <h2>Our Pick: Product Name</h2>
      <p>Reasoning for why this is the best pick for the user's needs.</p>
      <p><strong>$X,XXX</strong></p>
      <p><a href="/products/product-url/">View Product</a></p>
    </div>
  </div>
</div>

### Testimonials Block
<div class="testimonials">
  <div>
    <div>
      <p>"Review content quote."</p>
      <p><strong>Author Name</strong></p>
      <p>Rating: ★★★★★</p>
    </div>
  </div>
  <!-- repeat for each testimonial -->
</div>

### Follow-Up Block
<div class="follow-up">
  <div>
    <div>
      <p><a href="/?q=suggestion+one">Suggestion One</a></p>
      <p><a href="/?q=suggestion+two">Suggestion Two</a></p>
      <p><a href="/?q=suggestion+three">Suggestion Three</a></p>
    </div>
  </div>
</div>

### Table Block (Specs)
<div class="table">
  <div>
    <div><strong>Specification</strong></div>
    <div><strong>Value</strong></div>
  </div>
  <div>
    <div>Boiler Type</div>
    <div>Dual Boiler, Stainless Steel</div>
  </div>
  <!-- repeat -->
</div>

### Tabs Block
<div class="tabs">
  <div>
    <div>Tab Label 1</div>
    <div><p>Tab content for the first tab.</p></div>
  </div>
  <div>
    <div>Tab Label 2</div>
    <div><p>Tab content for the second tab.</p></div>
  </div>
</div>

### Text Block
<div class="text">
  <div>
    <div>
      <h2>Section Heading</h2>
      <p>Paragraph of content.</p>
    </div>
  </div>
</div>

Return ONLY the HTML for the requested block. No markdown fences. No explanation.`;

/**
 * Generates HTML content for a single block using Gemini.
 *
 * @param block         The block selection from the reasoning engine
 * @param intent        Classified intent for context
 * @param ragContext    RAG context with product/guide data
 * @param allBlocks     All blocks in the layout (for context about what other blocks exist)
 * @param preset        Optional model preset override
 * @param modelOverride Optional model name override
 * @returns A GeneratedBlock with type, HTML, and optional section style
 */
export async function generateBlockContent(
  block: BlockSelection,
  intent: IntentClassification,
  ragContext: RAGContext,
  allBlocks: BlockSelection[],
  preset?: string,
  modelOverride?: string,
  sessionContext?: SessionContext,
): Promise<GeneratedBlock> {
  const blockType = block.type;

  // Special-case handlers for blocks that can be generated deterministically
  if (blockType === 'follow-up') {
    return generateFollowUpBlock(intent, ragContext, intent.entities.products[0] || '', sessionContext);
  }

  if (blockType === 'hero') {
    return generateHeroBlock(intent, ragContext, block.contentGuidance || '');
  }

  const factory = createModelFactory(preset || modelOverride);
  const prompt = buildBlockPrompt(block, intent, ragContext, allBlocks);

  const messages: Message[] = [
    { role: 'system', content: CONTENT_GENERATION_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  try {
    const response = await factory.call('content', messages);
    let html = response.content.trim();

    // Strip any markdown fences the model might have added
    html = stripMarkdownFences(html);

    // Validate the HTML has the expected block wrapper
    if (!html.includes(`class="${blockType}"`)) {
      html = `<div class="${blockType}">\n  <div>\n    <div>${html}</div>\n  </div>\n</div>`;
    }

    return {
      type: blockType,
      html,
      sectionStyle: BLOCK_SECTION_STYLES[blockType] || 'default',
    };
  } catch (error) {
    console.error(`[orchestrator] Block generation failed for "${blockType}":`, error);
    return generateFallbackBlock(blockType, intent, ragContext);
  }
}

/* ========================================================================== */
/*  3. Special Block Generators                                                */
/* ========================================================================== */

/**
 * Generates the follow-up suggestion block with contextual query chips.
 * This is generated deterministically without calling the LLM.
 */
export function generateFollowUpBlock(
  intent: IntentClassification,
  ragContext: RAGContext,
  query: string,
  sessionContext?: SessionContext,
): GeneratedBlock {
  const suggestions = buildFollowUpSuggestions(intent, ragContext, query, sessionContext);

  const chipLinks = suggestions
    .map((s) => {
      const encoded = encodeURIComponent(s);
      return `      <p><a href="/?q=${encoded}">${s}</a></p>`;
    })
    .join('\n');

  const html = `<div class="follow-up">
  <div>
    <div>
${chipLinks}
    </div>
  </div>
</div>`;

  return { type: 'follow-up', html, sectionStyle: 'default' };
}

/**
 * Builds contextual follow-up suggestions based on the actual query,
 * RAG-matched products, intent classification, and optional browsing history.
 */
function buildFollowUpSuggestions(
  intent: IntentClassification,
  ragContext: RAGContext,
  query: string,
  sessionContext?: SessionContext,
): string[] {
  const suggestions: string[] = [];
  const products = ragContext.relevantProducts || [];
  const guides = ragContext.relevantBrewGuides || [];
  const browsingProfile = sessionContext?.inferredProfile;
  const lower = query.toLowerCase();

  // 1. Product-specific suggestions from RAG results
  if (products.length >= 2) {
    suggestions.push(`Compare ${products[0].name} vs ${products[1].name}`);
  }
  if (products.length >= 1) {
    // Suggest a product the query didn't explicitly mention
    const mentionedNames = intent.entities.products.map((p) => p.toLowerCase());
    const other = products.find(
      (p) => !mentionedNames.some((m) => p.name.toLowerCase().includes(m)),
    );
    if (other) {
      suggestions.push(`Tell me about the ${other.name}`);
    }
  }

  // 2. Browsing context (session-aware)
  if (browsingProfile?.productsViewed && browsingProfile.productsViewed.length >= 2) {
    const [a, b] = browsingProfile.productsViewed.slice(-2);
    suggestions.push(`Compare ${formatModelName(a)} vs ${formatModelName(b)}`);
  }
  if (browsingProfile?.quizAnswers && Object.keys(browsingProfile.quizAnswers).length > 0) {
    suggestions.push('Which machine matches my quiz results?');
  }

  // 3. Brew guide suggestion if available
  if (guides.length > 0) {
    suggestions.push(`How do I ${guides[0].name.toLowerCase()}?`);
  }

  // 4. Query-contextual suggestions based on keywords
  if (/grinder|grind|burr/i.test(lower)) {
    suggestions.push('What espresso machine pairs well with this grinder?');
    suggestions.push('Flat burrs vs conical burrs — which is better?');
  } else if (/machine|espresso.*machine/i.test(lower)) {
    suggestions.push('What grinder should I pair with this?');
    suggestions.push('What accessories do I need to get started?');
  } else if (/latte|cappuccino|milk|steam|flat white/i.test(lower)) {
    suggestions.push('How do I steam milk for latte art?');
    suggestions.push('Which machine has the best steam wand?');
  } else if (/beginner|start|first|new to/i.test(lower)) {
    suggestions.push('How much should I budget for a full setup?');
    suggestions.push('What mistakes do beginners make?');
  } else if (/compare|vs|versus|difference/i.test(lower)) {
    suggestions.push('Which one is better for daily use?');
    suggestions.push('Show me the full espresso machine lineup');
  } else if (/clean|descal|mainten/i.test(lower)) {
    suggestions.push('How often should I descale?');
    suggestions.push('What cleaning accessories do I need?');
  } else if (/gift|present|someone/i.test(lower)) {
    suggestions.push('What accessories make good gifts?');
    suggestions.push('Which machine is easiest for a non-barista?');
  } else if (/budget|cheap|afford|price|cost/i.test(lower)) {
    suggestions.push('What is the best value espresso machine?');
    suggestions.push('Is there a bundle deal?');
  } else if (/upgrade|better|improve/i.test(lower)) {
    suggestions.push('Should I upgrade my grinder or machine first?');
    suggestions.push('What is the next step up from my current setup?');
  } else if (/recipe|brew|extract|dial|shot/i.test(lower)) {
    suggestions.push('What grind size should I use?');
    suggestions.push('How do I dial in my shots?');
  }

  // 5. Intent-based fallbacks (only if we still need more)
  if (suggestions.length < 3) {
    switch (intent.intentType) {
      case 'beginner':
        suggestions.push('What grinder should I get as a beginner?');
        break;
      case 'comparison':
        suggestions.push('Which one is better for milk drinks?');
        break;
      case 'technique':
        suggestions.push('What grind size for espresso?');
        break;
      case 'support':
        suggestions.push('How do I descale my machine?');
        break;
      default:
        break;
    }
  }

  // 6. General fallbacks — pick from a pool based on query hash to vary them
  const generalPool = [
    'Show me all espresso machines',
    'Help me choose a grinder',
    'What accessories do I need?',
    'Compare the Primo vs the Doppio',
    'What is the best machine for beginners?',
    'Tell me about the Studio Pro',
    'How do I make better espresso at home?',
    'What is the difference between manual and automatic?',
  ];
  // Simple hash of query to pick different defaults each time
  const hash = lower.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0);
  let poolIdx = hash % generalPool.length;
  while (suggestions.length < 4) {
    const candidate = generalPool[poolIdx % generalPool.length];
    if (!suggestions.includes(candidate) && !lower.includes(candidate.toLowerCase())) {
      suggestions.push(candidate);
    }
    poolIdx += 1;
    // Safety: stop if we've gone through the whole pool
    if (poolIdx > hash + generalPool.length) break;
  }

  // Deduplicate and limit to 4
  const unique = [...new Set(suggestions)];
  return unique.slice(0, 4);
}

/**
 * Generates the hero block using selectHeroImage() for the background image.
 */
export function generateHeroBlock(
  intent: IntentClassification,
  ragContext: RAGContext,
  query: string,
): GeneratedBlock {
  const heroImageUrl = selectHeroImage(
    intent.intentType,
    intent.entities.useCases,
    query,
  );

  // Determine headline and subtitle based on intent
  const { headline, subtitle, ctaText, ctaHref } = buildHeroCopy(intent, ragContext, query);

  const ctaHtml = ctaText
    ? `\n      <p><a href="${ctaHref}">${ctaText}</a></p>`
    : '';

  const html = `<div class="hero">
  <div>
    <div>
      <picture><img src="${heroImageUrl}" alt="${headline}"></picture>
    </div>
    <div>
      <h1>${headline}</h1>
      <p>${subtitle}</p>${ctaHtml}
    </div>
  </div>
</div>`;

  return { type: 'hero', html, sectionStyle: 'dark' };
}

/**
 * Builds hero copy (headline, subtitle, CTA) based on intent and context.
 */
function buildHeroCopy(
  intent: IntentClassification,
  ragContext: RAGContext,
  query: string,
): { headline: string; subtitle: string; ctaText: string; ctaHref: string } {
  const products = ragContext.relevantProducts || [];
  const primaryProduct = products[0];

  switch (intent.intentType) {
    case 'beginner':
      return {
        headline: 'Welcome to the World of Real Espresso',
        subtitle: 'Making the switch is easier than you think. Let us find the perfect machine for your journey.',
        ctaText: 'Find Your First Machine',
        ctaHref: '/?q=best+espresso+machine+for+beginners',
      };

    case 'comparison':
      if (intent.entities.products.length >= 2) {
        return {
          headline: `${formatModelName(intent.entities.products[0])} vs ${formatModelName(intent.entities.products[1])}`,
          subtitle: 'A detailed comparison to help you choose the right machine.',
          ctaText: 'See Full Comparison',
          ctaHref: '#comparison-table',
        };
      }
      return {
        headline: 'Compare Arco Machines',
        subtitle: 'Side-by-side specifications, features, and real customer experiences.',
        ctaText: 'View All Machines',
        ctaHref: '/products/',
      };

    case 'product-detail':
      if (primaryProduct) {
        return {
          headline: primaryProduct.name,
          subtitle: primaryProduct.tagline || primaryProduct.description || 'Premium coffee equipment by Arco.',
          ctaText: 'View Full Details',
          ctaHref: primaryProduct.url,
        };
      }
      return {
        headline: 'Arco Coffee Equipment',
        subtitle: 'Precision-engineered for the perfect cup, every time.',
        ctaText: 'Explore Products',
        ctaHref: '/products/',
      };

    case 'gift':
      return {
        headline: 'The Perfect Coffee Gift',
        subtitle: 'Give the gift of exceptional espresso. Find the ideal machine for every coffee lover.',
        ctaText: 'Browse Gift Ideas',
        ctaHref: '/?q=best+coffee+gifts',
      };

    case 'support':
      return {
        headline: 'We\'re Here to Help',
        subtitle: 'Get support for your Arco equipment. Troubleshooting, maintenance, and warranty information.',
        ctaText: 'Contact Support',
        ctaHref: '/support/',
      };

    case 'technique':
      return {
        headline: 'Master Your Craft',
        subtitle: 'Brew guides, techniques, and tips to elevate your coffee game.',
        ctaText: 'Explore Brew Guides',
        ctaHref: '/guides/',
      };

    case 'upgrade':
      return {
        headline: 'Ready for the Next Level?',
        subtitle: 'Upgrade your setup and unlock new possibilities in your coffee journey.',
        ctaText: 'See Upgrade Options',
        ctaHref: '/?q=upgrade+from+' + encodeURIComponent(query.slice(0, 30)),
      };

    case 'price':
      return {
        headline: 'Find Your Perfect Match',
        subtitle: 'Quality espresso equipment at every price point. From entry-level to professional.',
        ctaText: 'View Price Guide',
        ctaHref: '/?q=arco+price+comparison',
      };

    default:
      return {
        headline: 'Discover Arco Coffee Equipment',
        subtitle: 'From beginner-friendly machines to professional-grade setups \u2014 find the perfect equipment for your coffee journey.',
        ctaText: 'Explore Machines',
        ctaHref: '/products/',
      };
  }
}

/* ========================================================================== */
/*  4. Prompt Builders                                                         */
/* ========================================================================== */

/**
 * Builds the full prompt for generating a specific block's HTML content.
 */
function buildBlockPrompt(
  block: BlockSelection,
  intent: IntentClassification,
  ragContext: RAGContext,
  allBlocks: BlockSelection[],
): string {
  const sections: string[] = [];

  // Header: what block and why
  sections.push(`## Task
Generate the HTML for an AEM EDS "${block.type}" block.

## Block Guidance
${block.contentGuidance || block.rationale || 'Generate appropriate content for this block type.'}

## User Intent
- Type: ${intent.intentType}
- Journey Stage: ${intent.journeyStage}
- Confidence: ${intent.confidence}
- Products mentioned: ${intent.entities.products.join(', ') || 'none'}
- Use cases: ${intent.entities.useCases.join(', ') || 'none'}
- Features of interest: ${intent.entities.features.join(', ') || 'none'}`);

  // Page layout context
  const blockTypes = allBlocks.map((b) => b.type).join(', ');
  sections.push(`## Page Layout Context
This block is part of a page with these blocks: [${blockTypes}]
Position: ${allBlocks.findIndex((b) => b.type === block.type) + 1} of ${allBlocks.length}`);

  // Product context
  const products = ragContext.relevantProducts || [];
  if (products.length > 0) {
    const productDescriptions = products.map((p) => formatProductForPrompt(p)).join('\n\n');
    sections.push(`## Available Product Data
${productDescriptions}`);
  }

  // Brew guide context
  const guides = ragContext.relevantBrewGuides || [];
  if (guides.length > 0) {
    const guideDescriptions = guides.map((g) => formatBrewGuideForPrompt(g)).join('\n\n');
    sections.push(`## Available Brew Guide Data
${guideDescriptions}`);
  }

  // Reviews context (for testimonials block)
  if (block.type === 'testimonials' || block.type === 'quote') {
    const allReviews = getAllReviews();
    const productIds = intent.entities.products;
    let relevantReviews: Review[] = [];

    if (productIds.length > 0) {
      for (const pid of productIds) {
        const productReviews = allReviews.filter(
          (r) => r.productId?.toLowerCase() === pid.toLowerCase()
            || r.productName?.toLowerCase().includes(pid.toLowerCase()),
        );
        relevantReviews.push(...productReviews);
      }
    }

    if (relevantReviews.length === 0) {
      // Take top-rated reviews as fallback
      relevantReviews = allReviews
        .filter((r) => (r.rating ?? 0) >= 4)
        .slice(0, 6);
    }

    if (relevantReviews.length > 0) {
      const reviewDescriptions = relevantReviews
        .slice(0, 6)
        .map((r) => formatReviewForPrompt(r))
        .join('\n\n');
      sections.push(`## Available Review Data
${reviewDescriptions}`);
    }
  }

  // FAQ context (for accordion block)
  if (block.type === 'accordion') {
    const queryStr = intent.entities.products.join(' ') + ' ' + intent.entities.useCases.join(' ');
    const relevantFAQs = getFAQsForQuery(queryStr || 'arco coffee');

    if (relevantFAQs.length > 0) {
      const faqDescriptions = relevantFAQs
        .slice(0, 8)
        .map((f) => formatFAQForPrompt(f))
        .join('\n\n');
      sections.push(`## Available FAQ Data
${faqDescriptions}`);
    }
  }

  // Block-specific instructions
  const blockInstructions = getBlockSpecificInstructions(block.type, intent);
  if (blockInstructions) {
    sections.push(`## Block-Specific Instructions
${blockInstructions}`);
  }

  sections.push(`## Output
Return ONLY the HTML for the "${block.type}" block. No markdown fences, no explanation text.`);

  return sections.join('\n\n');
}

/**
 * Returns block-type-specific instructions for the content generator.
 */
function getBlockSpecificInstructions(
  blockType: string,
  intent: IntentClassification,
): string | null {
  switch (blockType) {
    case 'cards':
      return `Generate a grid of 3-4 product cards. Each card MUST include:
- Product image from the context data
- Product name as an h3
- Brief description (1-2 sentences)
- Price in bold
- "Learn More" link to the product URL
Only use products from the provided product data. Do NOT invent products.`;

    case 'comparison-table':
      return `Create a side-by-side comparison table with:
- Header row with "Feature" and each product name
- Price row
- Key spec rows relevant to the user's needs (boiler type, PID, pressure, dimensions, weight)
- Best-for / use-case row
Only use specs from the provided product data. Mark unavailable specs as "—".`;

    case 'accordion':
      return `Create an FAQ accordion section. Each item has:
- A question as an h3 in the first column
- The answer as paragraph(s) in the second column
Use the provided FAQ data if available. Keep answers concise and helpful.`;

    case 'best-pick':
      return `Highlight the single best product recommendation. Include:
- Product image
- "Our Pick: [Product Name]" as h2
- 2-3 sentences explaining why this is the best choice for the user's specific needs
- Price in bold
- Link to the product page
Base the recommendation on the user's intent and the product data provided.`;

    case 'testimonials':
      return `Show 2-3 customer testimonials. Each must include:
- The review quote in quotation marks
- Author name in bold
- Star rating using ★ characters
Only use reviews from the provided review data. Do NOT fabricate reviews.`;

    case 'table':
      return `Create a specifications table. Include:
- Header row with "Specification" and "Value" columns (or product names for multi-product tables)
- Relevant spec rows based on the user's interests
- Use the exact spec values from the product data`;

    case 'tabs':
      return `Create a tabbed content section. Each tab has:
- Tab label in the first column
- Tab content in the second column
Organise content logically (e.g., "Overview", "Specs", "Reviews", "Brew Guides").`;

    case 'text':
      return `Generate a plain text content section with:
- An h2 heading
- 1-3 paragraphs of informative content
- Optional bulleted list
Keep the tone warm, knowledgeable, and helpful.`;

    case 'budget-breakdown':
      return `Create a budget breakdown showing:
- Price tiers: Under $700 / $700-$2,000 / $2,000+
- Best machine in each tier from the product data
- What the user gets at each price point
Use real prices from the product data.`;

    case 'support-triage':
      return `Create a support triage block with:
- Empathetic heading acknowledging the issue
- Common troubleshooting steps if applicable
- Link to contact support
- Warranty information reminder`;

    case 'quick-answer':
      return `Provide a direct, concise answer to the user's yes/no or quick question.
- Lead with the answer
- Follow with 1-2 sentences of context
- Include a relevant product link if applicable`;

    case 'feature-highlights':
      return `Showcase 3-4 key features relevant to the user's query. Each feature:
- Feature name as h3
- 1-2 sentence benefit description
- Which Arco products offer this feature`;

    case 'use-case-cards':
      return `Create cards for different use cases. Each card:
- Use case name as h3
- Brief description
- Recommended product for that use case
- Link to explore more`;

    default:
      return null;
  }
}

/* ========================================================================== */
/*  5. Data Formatting Helpers                                                 */
/* ========================================================================== */

/**
 * Formats a product for inclusion in an LLM prompt.
 */
function formatProductForPrompt(product: Product): string {
  const lines: string[] = [];

  lines.push(`### ${product.name}`);
  lines.push(`- ID: ${product.id}`);
  lines.push(`- Series: ${product.series}`);
  lines.push(`- Price: $${product.price.toLocaleString()}`);
  if (product.originalPrice) {
    lines.push(`- Original Price: $${product.originalPrice.toLocaleString()}`);
  }
  lines.push(`- URL: ${product.url}`);
  if (product.availability) {
    lines.push(`- Availability: ${product.availability}`);
  }
  if (product.tagline) {
    lines.push(`- Tagline: ${product.tagline}`);
  }
  if (product.description) {
    lines.push(`- Description: ${product.description}`);
  }
  if (product.features && product.features.length > 0) {
    lines.push(`- Features: ${product.features.join('; ')}`);
  }
  if (product.bestFor && product.bestFor.length > 0) {
    lines.push(`- Best For: ${product.bestFor.join(', ')}`);
  }
  if (product.warranty) {
    lines.push(`- Warranty: ${product.warranty}`);
  }

  // Include specs if available
  if (product.specs && typeof product.specs === 'object') {
    const specEntries = Object.entries(product.specs)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `  - ${formatSpecKey(k)}: ${v}`)
      .join('\n');
    if (specEntries) {
      lines.push(`- Specs:\n${specEntries}`);
    }
  }

  // Include primary image if available
  const imageUrl = getProductImageUrl(product);
  if (imageUrl) {
    lines.push(`- Image: ${imageUrl}`);
  }

  return lines.join('\n');
}

/**
 * Formats a brew guide for inclusion in an LLM prompt.
 */
function formatBrewGuideForPrompt(guide: BrewGuide): string {
  const lines: string[] = [];

  lines.push(`### ${guide.name}`);
  lines.push(`- Category: ${guide.category}`);
  if (guide.subcategory) lines.push(`- Subcategory: ${guide.subcategory}`);
  if (guide.difficulty) lines.push(`- Difficulty: ${guide.difficulty}`);
  if (guide.description) lines.push(`- Description: ${guide.description}`);
  if (guide.grindSize) lines.push(`- Grind Size: ${guide.grindSize}`);
  if (guide.dose) lines.push(`- Dose: ${guide.dose}`);
  if (guide.yield) lines.push(`- Yield: ${guide.yield}`);
  if (guide.extractionTime) lines.push(`- Extraction Time: ${guide.extractionTime}`);
  if (guide.temperature) lines.push(`- Temperature: ${guide.temperature}`);
  if (guide.pressure) lines.push(`- Pressure: ${guide.pressure}`);
  if (guide.technique && guide.technique.length > 0) {
    lines.push(`- Technique Steps: ${guide.technique.join(' → ')}`);
  }
  if (guide.requiredEquipment && guide.requiredEquipment.length > 0) {
    lines.push(`- Required Equipment: ${guide.requiredEquipment.join(', ')}`);
  }
  if (guide.tips && guide.tips.length > 0) {
    lines.push(`- Tips: ${guide.tips.join('; ')}`);
  }
  if (guide.recommendedProducts && guide.recommendedProducts.length > 0) {
    lines.push(`- Recommended Products: ${guide.recommendedProducts.join(', ')}`);
  }
  if (guide.url) lines.push(`- URL: ${guide.url}`);

  return lines.join('\n');
}

/**
 * Formats a review for inclusion in an LLM prompt.
 */
function formatReviewForPrompt(review: Review): string {
  const lines: string[] = [];

  lines.push(`### Review by ${review.author}`);
  if (review.productName) lines.push(`- Product: ${review.productName}`);
  if (review.productId) lines.push(`- Product ID: ${review.productId}`);
  if (review.rating) lines.push(`- Rating: ${review.rating}/5`);
  if (review.title) lines.push(`- Title: ${review.title}`);
  lines.push(`- Content: "${review.body}"`);
  if (review.verified) lines.push(`- Verified Purchase: Yes`);
  if (review.useCase) lines.push(`- Use Case: ${review.useCase}`);
  if (review.date) lines.push(`- Date: ${review.date}`);
  if (review.pros && review.pros.length > 0) {
    lines.push(`- Pros: ${review.pros.join(', ')}`);
  }
  if (review.cons && review.cons.length > 0) {
    lines.push(`- Cons: ${review.cons.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Formats an FAQ for inclusion in an LLM prompt.
 */
function formatFAQForPrompt(faq: FAQ): string {
  const lines: string[] = [];

  lines.push(`### FAQ: ${faq.question}`);
  lines.push(`- Category: ${faq.category}`);
  lines.push(`- Answer: ${faq.answer}`);
  if (faq.relatedProducts && faq.relatedProducts.length > 0) {
    lines.push(`- Related Products: ${faq.relatedProducts.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Converts camelCase spec keys to readable labels.
 */
function formatSpecKey(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim();
}

/**
 * Converts a model ID like 'studio-pro' to a display name like 'Studio Pro'.
 */
function formatModelName(modelId: string): string {
  return modelId
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/* ========================================================================== */
/*  6. Fallback Block Generation                                               */
/* ========================================================================== */

/**
 * Generates a sensible fallback block when LLM content generation fails.
 */
function generateFallbackBlock(
  blockType: string,
  intent: IntentClassification,
  ragContext: RAGContext,
): GeneratedBlock {
  const products = ragContext.relevantProducts || [];
  const sectionStyle = BLOCK_SECTION_STYLES[blockType] || 'default';

  switch (blockType) {
    case 'cards': {
      const cardProducts = products.slice(0, 4);
      if (cardProducts.length === 0) {
        const allProds = getAllProducts().slice(0, 4);
        return {
          type: 'cards',
          html: buildFallbackCardsHtml(allProds),
          sectionStyle,
        };
      }
      return {
        type: 'cards',
        html: buildFallbackCardsHtml(cardProducts),
        sectionStyle,
      };
    }

    case 'comparison-table': {
      const compareProducts = products.slice(0, 3);
      if (compareProducts.length < 2) {
        return {
          type: 'text',
          html: `<div class="text">
  <div>
    <div>
      <h2>Product Comparison</h2>
      <p>We need at least two products to compare. <a href="/products/">Browse all Arco products</a> to find the right machines for your needs.</p>
    </div>
  </div>
</div>`,
          sectionStyle,
        };
      }
      return {
        type: 'comparison-table',
        html: buildFallbackComparisonHtml(compareProducts),
        sectionStyle,
      };
    }

    case 'best-pick': {
      const bestProduct = products[0];
      if (!bestProduct) {
        return {
          type: 'text',
          html: `<div class="text">
  <div>
    <div>
      <h2>Our Recommendation</h2>
      <p>Tell us more about your needs so we can recommend the perfect Arco machine for you.</p>
    </div>
  </div>
</div>`,
          sectionStyle,
        };
      }
      const imageUrl = getProductImageUrl(bestProduct);
      return {
        type: 'best-pick',
        html: `<div class="best-pick">
  <div>
    <div>${imageUrl ? `<picture><img src="${imageUrl}" alt="${bestProduct.name}"></picture>` : ''}</div>
    <div>
      <h2>Our Pick: ${bestProduct.name}</h2>
      <p>${bestProduct.tagline || bestProduct.description || 'A premium choice from the Arco lineup.'}</p>
      <p><strong>$${bestProduct.price.toLocaleString()}</strong></p>
      <p><a href="${bestProduct.url}">View Product</a></p>
    </div>
  </div>
</div>`,
        sectionStyle,
      };
    }

    case 'accordion': {
      const queryStr = intent.entities.products.join(' ') + ' ' + intent.entities.useCases.join(' ');
      const faqs = getFAQsForQuery(queryStr || 'arco coffee').slice(0, 5);
      if (faqs.length > 0) {
        const faqRows = faqs
          .map((f) => `  <div>\n    <div><h3>${f.question}</h3></div>\n    <div><p>${f.answer}</p></div>\n  </div>`)
          .join('\n');
        return {
          type: 'accordion',
          html: `<div class="accordion">\n${faqRows}\n</div>`,
          sectionStyle,
        };
      }
      return {
        type: 'accordion',
        html: `<div class="accordion">
  <div>
    <div><h3>What makes Arco different?</h3></div>
    <div><p>Arco machines are designed with precision engineering, premium materials, and attention to every detail of the espresso-making process.</p></div>
  </div>
  <div>
    <div><h3>Which machine is right for me?</h3></div>
    <div><p>It depends on your needs! Tell us about your coffee habits and we'll recommend the perfect setup.</p></div>
  </div>
</div>`,
        sectionStyle,
      };
    }

    case 'testimonials': {
      const reviews = getAllReviews()
        .filter((r) => (r.rating ?? 0) >= 4)
        .slice(0, 3);
      if (reviews.length > 0) {
        const reviewRows = reviews
          .map((r) => {
            const stars = '\u2605'.repeat(r.rating || 5);
            return `  <div>\n    <div>\n      <p>"${r.body}"</p>\n      <p><strong>${r.author}</strong></p>\n      <p>Rating: ${stars}</p>\n    </div>\n  </div>`;
          })
          .join('\n');
        return {
          type: 'testimonials',
          html: `<div class="testimonials">\n${reviewRows}\n</div>`,
          sectionStyle,
        };
      }
      return {
        type: 'testimonials',
        html: `<div class="testimonials">
  <div>
    <div>
      <p>"The build quality is exceptional. Best espresso I've ever made at home."</p>
      <p><strong>Arco Customer</strong></p>
      <p>Rating: \u2605\u2605\u2605\u2605\u2605</p>
    </div>
  </div>
</div>`,
        sectionStyle,
      };
    }

    default:
      return {
        type: 'text',
        html: `<div class="text">
  <div>
    <div>
      <h2>Arco Coffee Equipment</h2>
      <p>Explore our range of premium espresso machines, grinders, and accessories. <a href="/products/">View all products</a>.</p>
    </div>
  </div>
</div>`,
        sectionStyle: 'default',
      };
  }
}

/**
 * Builds fallback cards HTML from product data.
 */
function buildFallbackCardsHtml(products: Product[]): string {
  const rows = products.map((p) => {
    const imageUrl = getProductImageUrl(p);
    const imageHtml = imageUrl
      ? `<picture><img src="${imageUrl}" alt="${p.name}"></picture>`
      : '';
    return `  <div>
    <div>${imageHtml}</div>
    <div>
      <h3>${p.name}</h3>
      <p>${p.tagline || p.description || p.series + ' series'}</p>
      <p><strong>$${p.price.toLocaleString()}</strong></p>
      <p><a href="${p.url}">Learn More</a></p>
    </div>
  </div>`;
  }).join('\n');

  return `<div class="cards">\n${rows}\n</div>`;
}

/**
 * Builds fallback comparison table HTML from product data.
 */
function buildFallbackComparisonHtml(products: Product[]): string {
  const headerCols = products.map((p) => `    <div><strong>${p.name}</strong></div>`).join('\n');

  // Collect common spec keys across products
  const specKeys = new Set<string>();
  for (const p of products) {
    if (p.specs && typeof p.specs === 'object') {
      for (const key of Object.keys(p.specs)) {
        specKeys.add(key);
      }
    }
  }

  const specRows = ['price', ...Array.from(specKeys)].map((key) => {
    const label = key === 'price' ? 'Price' : formatSpecKey(key);
    const values = products.map((p) => {
      if (key === 'price') return `$${p.price.toLocaleString()}`;
      const specs = p.specs as Record<string, unknown> | undefined;
      if (!specs || specs[key] === undefined || specs[key] === null) return '\u2014';
      return String(specs[key]);
    });
    const valueCols = values.map((v) => `    <div>${v}</div>`).join('\n');
    return `  <div>\n    <div>${label}</div>\n${valueCols}\n  </div>`;
  }).join('\n');

  return `<div class="comparison-table">
  <div>
    <div><strong>Feature</strong></div>
${headerCols}
  </div>
${specRows}
</div>`;
}

/**
 * Resolves a media path to a full DA content URL.
 * Handles both relative paths (/media/...) and already-absolute URLs.
 */
function resolveMediaUrl(path: string): string {
  if (path.startsWith('http')) return path;
  const org = process.env.DA_ORG;
  const repo = process.env.DA_REPO;
  if (!org || !repo) return path;
  return `https://content.da.live/${org}/${repo}${path}`;
}

/**
 * Extracts the best available image URL for a product.
 */
function getProductImageUrl(product: Product): string | null {
  if (!product.images) return null;
  // Handle array of URLs/paths (actual data format from products.json)
  if (Array.isArray(product.images) && product.images.length > 0) {
    return resolveMediaUrl(String(product.images[0]));
  }
  // Handle object format as fallback
  const images = product.images as Record<string, unknown>;
  if (typeof images.primary === 'string') return resolveMediaUrl(images.primary);
  if (Array.isArray(images.remoteUrls) && images.remoteUrls.length > 0) {
    return resolveMediaUrl(String(images.remoteUrls[0]));
  }
  return null;
}

/* ========================================================================== */
/*  7. Main Orchestration Pipeline                                             */
/* ========================================================================== */

/**
 * Main orchestration entry point. Coordinates the full recommendation pipeline
 * and streams results to the client via SSE events.
 *
 * @param query          The user's natural language query
 * @param slug           URL slug for the generated page
 * @param env            Environment bindings (GCP credentials, DA config, etc.)
 * @param write          SSE callback to stream events to the client
 * @param sessionContext Optional session context for conversational continuity
 * @param preset         Optional model preset override
 * @param modelOverride  Optional model name override
 */
export async function orchestrate(
  query: string,
  slug: string,
  env: Env,
  write: SSECallback,
  sessionContext?: SessionContext,
  preset?: string,
  modelOverride?: string,
): Promise<void> {
  const startTime = Date.now();
  const context: OrchestrationContext = { query, slug };

  try {
    // ── Phase 1: Intent Classification ──────────────────────────────────
    write({
      event: 'block-start',
      data: { blockType: 'hero' as BlockType, index: 0 },
    });

    write({
      event: 'reasoning-start',
      data: {
        model: preset || modelOverride || 'production',
        preset,
      },
    });

    console.log(`[orchestrator] Classifying intent for: "${query}"`);
    if (sessionContext) {
      const bh = sessionContext.browsingHistory || [];
      const pq = sessionContext.previousQueries || [];
      const ip = sessionContext.inferredProfile;
      console.log(`[orchestrator] Session context: ${bh.length} pages visited, ${pq.length} previous queries`);
      if (bh.length > 0) {
        console.log(`[orchestrator]   Pages: ${bh.slice(-5).map((h) => h.path || 'unknown').join(', ')}`);
      }
      if (ip) {
        const interests = ip.interests?.length ? ip.interests.join(', ') : 'none';
        const viewed = ip.productsViewed?.length ? ip.productsViewed.join(', ') : 'none';
        console.log(`[orchestrator]   Profile: interests=[${interests}], products=[${viewed}], stage=${ip.journeyStage || 'unknown'}`);
      }
    }
    const intent = await classifyIntent(query, sessionContext, preset, modelOverride);
    context.intent = intent;

    console.log(`[orchestrator] Intent: ${intent.intentType} (confidence: ${intent.confidence})`);
    console.log(`[orchestrator] Entities: products=[${intent.entities.products}], useCases=[${intent.entities.useCases}]`);

    write({
      event: 'reasoning-step',
      data: {
        stage: 'classification',
        title: 'Understanding Your Query',
        content: `Intent: ${intent.intentType} | Stage: ${intent.journeyStage} | Confidence: ${Math.round(intent.confidence * 100)}%`,
      },
    });

    // ── Phase 2: Build RAG Context ──────────────────────────────────────
    console.log('[orchestrator] Building RAG context...');
    const ragContext = buildRAGContext(query, intent.intentType);
    context.ragContext = ragContext;

    const productNames = (ragContext.relevantProducts || []).map((p) => p.name).join(', ');
    const guideNames = (ragContext.relevantBrewGuides || []).map((g) => g.name).slice(0, 3).join(', ');
    console.log(`[orchestrator] RAG context: ${ragContext.relevantProducts?.length || 0} products, ${ragContext.relevantBrewGuides?.length || 0} guides`);

    write({
      event: 'reasoning-step',
      data: {
        stage: 'context',
        title: 'Gathering Product Knowledge',
        content: `Found ${ragContext.relevantProducts?.length || 0} relevant products${productNames ? `: ${productNames}` : ''}${guideNames ? ` | Guides: ${guideNames}` : ''}`,
      },
    });

    // ── Phase 2b: Stream Early Blocks (hero + follow-up) ────────────────
    // Hero and follow-up are deterministic (no LLM call). Stream them
    // immediately so the user sees content in <1s while reasoning runs.
    const earlyBlocks: GeneratedBlock[] = [];

    const heroBlock = generateHeroBlock(intent, ragContext, query);
    earlyBlocks.push(heroBlock);
    write({
      event: 'block-content',
      data: { html: heroBlock.html, sectionStyle: heroBlock.sectionStyle },
    });
    console.log('[orchestrator] Streamed early hero block');

    const followUpBlock = generateFollowUpBlock(intent, ragContext, query, sessionContext);
    earlyBlocks.push(followUpBlock);
    write({
      event: 'block-content',
      data: { html: followUpBlock.html, sectionStyle: followUpBlock.sectionStyle },
    });
    console.log('[orchestrator] Streamed early follow-up block');

    // ── Phase 3: Deep Reasoning (Block Selection) ───────────────────────
    console.log('[orchestrator] Running deep reasoning (block selection)...');
    const reasoningStart = Date.now();

    const reasoningResult = await analyzeAndSelectBlocks(
      { text: query },
      ragContext,
      preset,
    );
    context.reasoningResult = reasoningResult;

    const reasoningDuration = Date.now() - reasoningStart;
    console.log(`[orchestrator] Reasoning complete in ${reasoningDuration}ms: ${(reasoningResult.blocks ?? []).length} blocks selected`);
    console.log(formatReasoningForDisplay(reasoningResult));

    write({
      event: 'reasoning-step',
      data: {
        stage: 'reasoning',
        title: 'Selecting Content Layout',
        content: (typeof reasoningResult.reasoning === 'string' ? reasoningResult.reasoning : '') || `Selected ${(reasoningResult.blocks ?? []).length} blocks for your response.`,
      },
    });

    write({
      event: 'reasoning-complete',
      data: {
        confidence: intent.confidence,
        duration: reasoningDuration,
      },
    });

    // ── Phase 4: Map Reasoning Blocks to BlockSelection ─────────────────
    // The reasoning engine returns blocks with { type, priority, content }.
    // We need to map them to BlockSelection for content generation.
    const blockSelections: BlockSelection[] = (reasoningResult.blocks ?? []).map((block: any) => ({
      type: block.type as BlockType,
      priority: block.priority,
      rationale: (typeof reasoningResult.reasoning === 'string' ? reasoningResult.reasoning : '') || '',
      contentGuidance: buildContentGuidanceFromReasoningBlock(block),
    }));

    // All block types for metadata (includes early-streamed hero + follow-up)
    const blockTypes = blockSelections.map((b) => b.type);

    // Filter out hero and follow-up — already streamed in Phase 2b
    const llmBlockSelections = blockSelections.filter(
      (b) => b.type !== 'hero' && b.type !== 'follow-up',
    );

    write({
      event: 'generation-start',
      data: {
        query,
        estimatedBlocks: llmBlockSelections.length + earlyBlocks.length,
      },
    });

    // ── Phase 5: Progressive Content Generation & Streaming ─────────────
    // Each block streams to the client as soon as its promise resolves,
    // rather than waiting for all blocks to finish first.
    console.log(`[orchestrator] Generating ${llmBlockSelections.length} LLM blocks progressively...`);

    const generatedBlocks: GeneratedBlock[] = [...earlyBlocks];
    let successCount = earlyBlocks.length;
    let failCount = 0;

    const streamPromises = llmBlockSelections.map((block, index) => {
      const promise = generateBlockContent(
        block,
        intent,
        ragContext,
        llmBlockSelections,
        preset,
        modelOverride,
        sessionContext,
      );

      return promise.then(
        (generated) => {
          generatedBlocks.push(generated);
          successCount++;

          write({
            event: 'block-start',
            data: { blockType: block.type, index: index + 1 },
          });
          write({
            event: 'block-content',
            data: {
              html: generated.html,
              sectionStyle: generated.sectionStyle,
            },
          });
          write({
            event: 'block-rationale',
            data: {
              blockType: block.type,
              rationale: block.rationale || block.contentGuidance || '',
            },
          });

          console.log(`[orchestrator] Block ${index + 1}/${llmBlockSelections.length} (${generated.type}) streamed`);
        },
        (reason) => {
          failCount++;
          console.error(`[orchestrator] Block ${index + 1}/${llmBlockSelections.length} (${block.type}) failed:`, reason);

          const fallback = generateFallbackBlock(block.type, intent, ragContext);
          generatedBlocks.push(fallback);

          write({
            event: 'block-content',
            data: {
              html: fallback.html,
              sectionStyle: fallback.sectionStyle,
            },
          });
        },
      );
    });

    // Wait for all LLM blocks before sending generation-complete
    await Promise.allSettled(streamPromises);

    context.generatedBlocks = generatedBlocks;

    // ── Phase 7: Generation Complete ────────────────────────────────────
    const totalDuration = Date.now() - startTime;

    console.log(`[orchestrator] Pipeline complete: ${successCount} succeeded, ${failCount} failed, ${totalDuration}ms total`);

    // Build enriched recommendations for the completion event
    const recommendedProducts = (ragContext.relevantProducts || []).map((p) => p.id);
    const recommendedBrewGuides = (ragContext.relevantBrewGuides || []).map((g) => g.id);

    write({
      event: 'generation-complete',
      data: {
        totalBlocks: generatedBlocks.length,
        duration: totalDuration,
        intent,
        reasoning: {
          journeyStage: intent.journeyStage,
          confidence: intent.confidence,
          nextBestAction: buildNextBestAction(intent, ragContext),
          suggestedFollowUps: buildFollowUpSuggestions(intent, ragContext, query, sessionContext),
        },
        recommendations: {
          products: recommendedProducts,
          brewGuides: recommendedBrewGuides,
          blockTypes: blockTypes as string[],
        },
      },
    });

    write({
      event: 'complete',
      data: { message: `Generated ${generatedBlocks.length} blocks in ${totalDuration}ms` },
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error('[orchestrator] Pipeline error:', error);

    write({
      event: 'error',
      data: {
        message: error instanceof Error ? error.message : 'An unexpected error occurred during content generation.',
        code: 'ORCHESTRATION_ERROR',
      },
    });

    // Attempt to send a minimal fallback response
    try {
      const fallbackIntent = context.intent || fallbackClassifyIntent(query);
      const fallbackRag = context.ragContext || buildRAGContext(query);

      const heroBlock = generateHeroBlock(fallbackIntent, fallbackRag, query);
      write({
        event: 'block-content',
        data: { html: heroBlock.html, sectionStyle: heroBlock.sectionStyle },
      });

      const followUp = generateFollowUpBlock(fallbackIntent, fallbackRag, query);
      write({
        event: 'block-content',
        data: { html: followUp.html, sectionStyle: followUp.sectionStyle },
      });

      write({
        event: 'generation-complete',
        data: {
          totalBlocks: 2,
          duration,
        },
      });
    } catch (fallbackError) {
      console.error('[orchestrator] Fallback generation also failed:', fallbackError);
    }
  }
}

/* ========================================================================== */
/*  8. Utility Functions                                                       */
/* ========================================================================== */

/**
 * Parses a JSON response from an LLM, handling markdown fences and bare JSON.
 */
function parseJSONResponse<T>(raw: string): T {
  let cleaned = raw.trim();

  // Strip markdown code fences
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  try {
    return JSON.parse(cleaned) as T;
  } catch {
    // Try to extract a JSON object from the string
    const objectMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      return JSON.parse(objectMatch[0]) as T;
    }
    throw new Error(`Failed to parse JSON from LLM response: ${cleaned.slice(0, 200)}...`);
  }
}

/**
 * Strips markdown code fences from a string.
 */
function stripMarkdownFences(text: string): string {
  let cleaned = text.trim();

  // Handle ```html ... ``` fences
  const htmlFenceMatch = cleaned.match(/```(?:html)?\s*([\s\S]*?)```/);
  if (htmlFenceMatch) {
    cleaned = htmlFenceMatch[1].trim();
  }

  return cleaned;
}

/**
 * Builds a "next best action" string based on the user's current journey stage.
 */
function buildNextBestAction(
  intent: IntentClassification,
  ragContext: RAGContext,
): string {
  const products = ragContext.relevantProducts || [];

  switch (intent.journeyStage) {
    case 'exploring':
      if (products.length > 0) {
        return `Explore the ${products[0].name} or compare it with other models`;
      }
      return 'Browse our range of espresso machines and grinders';

    case 'comparing':
      if (products.length >= 2) {
        return `Compare ${products[0].name} vs ${products[1].name} in detail`;
      }
      return 'Narrow down your options by comparing specifications';

    case 'deciding':
      if (products.length > 0) {
        return `Ready to order? View the ${products[0].name} product page`;
      }
      return 'Contact us for personalised advice before purchasing';

    default:
      return 'Explore our product range to find the perfect coffee equipment';
  }
}

/**
 * Builds content guidance from a reasoning engine block's content object.
 * Maps the block's content fields into a human-readable guidance string
 * for the content generator.
 */
function buildContentGuidanceFromReasoningBlock(
  block: { type: string; priority: number; content: Record<string, unknown> },
): string {
  const parts: string[] = [];

  if (block.content) {
    for (const [key, value] of Object.entries(block.content)) {
      if (value === undefined || value === null) continue;

      if (key === 'headline' || key === 'subheadline') {
        parts.push(`${key}: "${value}"`);
      } else if (key === 'filter') {
        parts.push(`Focus on ${value} products`);
      } else if (key === 'category') {
        parts.push(`Category: ${value}`);
      } else if (key === 'models' && Array.isArray(value)) {
        parts.push(`Compare models: ${value.join(', ')}`);
      } else if (key === 'query') {
        parts.push(`Based on user query: "${value}"`);
      } else if (key === 'focus') {
        parts.push(`Focus on: ${value}`);
      } else if (key === 'topic') {
        parts.push(`Topic: ${value}`);
      } else if (key === 'suggestions' && Array.isArray(value)) {
        parts.push(`Suggestions: ${value.join(', ')}`);
      } else if (key === 'model') {
        parts.push(`Specific model: ${value}`);
      } else if (key === 'type') {
        parts.push(`Type: ${value}`);
      } else if (key === 'products' && Array.isArray(value)) {
        parts.push(`Products: ${value.join(', ')}`);
      }
    }
  }

  if (parts.length === 0) {
    return `Generate content appropriate for a "${block.type}" block with priority ${block.priority}.`;
  }

  return parts.join('. ') + '.';
}

/* ========================================================================== */
/*  Exports                                                                    */
/* ========================================================================== */

export {
  type OrchestrationContext,
  type GeneratedBlock,
  type SSECallback,
};
