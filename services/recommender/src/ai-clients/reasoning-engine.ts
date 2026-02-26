/**
 * Arco Coffee Equipment Recommender — Reasoning Engine
 *
 * Analyses user queries, selects the optimal set of AEM blocks, and produces
 * structured reasoning output that drives the front-end experience.
 *
 * Adapted for the Arco coffee equipment product line.
 */

import type {
  BlockRecommendation,
  BrewGuide,
  Product,
  ReasoningResult,
  UserQuery,
} from '../types';
import type { RAGContext } from '../content/content-service';
import { GoogleModelFactory } from './model-factory-google';

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Canonical Arco model names used for detection. */
const ARCO_MODELS = [
  'primo',
  'doppio',
  'nano',
  'studio',
  'studio-pro',
  'ufficio',
  'viaggio',
  'automatico',
  'filtro',
  'preciso',
  'macinino',
  'zero',
] as const;

type ArcoModelName = (typeof ARCO_MODELS)[number];

/** Regex patterns that match Arco model names in free-form text. */
const MODEL_PATTERNS: RegExp[] = [
  /\bprimo\b/gi,
  /\bdoppio\b/gi,
  /\bnano\b/gi,
  /\bstudio\b/gi,
  /\bstudio\s*-?\s*pro\b/gi,
  /\bufficio\b/gi,
  /\bviaggio\b/gi,
  /\bautomatico\b/gi,
  /\bfiltro\b/gi,
  /\bpreciso\b/gi,
  /\bmacinino\b/gi,
  /\bzero\b/gi,
];

/* -------------------------------------------------------------------------- */
/*  System Prompt                                                              */
/* -------------------------------------------------------------------------- */

const REASONING_SYSTEM_PROMPT = `You are the **Arco Coffee Equipment Recommender**, an expert AI assistant
that helps customers find the perfect espresso machine, grinder, or coffee
accessory from the Arco product lineup.

Your job is to analyse the user's query, reason about what they need, and
select the best combination of AEM content blocks to create a rich, helpful,
and visually engaging response page.

## Available Blocks

| Block               | Purpose                                                       |
|---------------------|---------------------------------------------------------------|
| hero                | Full-width banner with headline and image — for landing/discovery |
| cards               | Grid of 3-4 product/content cards — for browsing              |
| columns             | Multi-column layout — for side-by-side content                |
| accordion           | Expandable/collapsible FAQ sections                           |
| tabs                | Tabbed content — for organised comparisons                    |
| table               | Data table — for specs comparisons                            |
| testimonials        | Customer reviews — for social proof                           |
| product-detail      | Single product detail view — for product deep-dive            |
| product-list        | Product listing with filtering                                |
| carousel            | Image carousel — for visual content                           |
| quote               | Testimonial quote — for highlighting a single review          |
| video               | Video embed — for tutorials                                   |
| quiz                | Interactive quiz — for product finder                         |
| follow-up           | Suggestion chips for next queries (ALWAYS include at the end) |
| quick-answer        | Simple direct answer for quick questions                      |
| support-triage      | Help frustrated customers                                     |
| budget-breakdown    | Price/value transparency                                      |
| best-pick           | Prominent "Best Pick" callout — use before comparison-table   |
| comparison-table    | Side-by-side product comparison                               |
| feature-highlights  | Key features showcase                                         |
| use-case-cards      | Use case selection grid                                       |
| text                | Plain text content section                                    |

## Special Handling Rules

1. **Support / Frustrated** — If the query contains "problem", "broken", "leaking",
   "warranty", "return", or "not working", lead with **support-triage**.
2. **Yes / No Questions** — If the query starts with "can arco", "will it",
   "does it", "is it worth", or "should I", lead with **quick-answer**.
3. **Beginner Queries** — Keywords: "first espresso machine", "switching from pods",
   "never made espresso", "beginner", "new to espresso", "nespresso". Use an
   empathetic **hero** followed by beginner-friendly recommendations.
4. **Budget-Conscious** — Keywords: "budget", "afford", "cheap", "worth it",
   "student", "expensive". Use **budget-breakdown**. Segment as under $700 /
   $700-$2000 / $2000+.
5. **Gift Queries** — Keywords: "gift", "birthday", "wedding", "christmas". Use
   **hero** + product recommendation cards.
6. **Office / Commercial** — Keywords: "restaurant", "office", "commercial",
   "business", "professional". Focus on specs and capacity.
7. **Travel / Portable** — Keywords: "travel", "portable", "camping", "office",
   "take with me". Highlight the Viaggio.
8. **Upgrade Queries** — Keywords: "outgrown", "upgrade", "pod machine",
   "better than", "step up". Compare with the user's current setup.
9. **Grinder-Specific** — Keywords: "grind size", "burr", "retention",
   "single dose", "flat vs conical". Provide technical grinder content.
10. **Latte Art** — Keywords: "microfoam", "milk steaming", "latte art",
    "flat white", "steam wand". Focus on milk steaming capability.
11. **Maintenance** — Keywords: "descaling", "backflush", "cleaning",
    "maintenance". Provide practical maintenance guides.
12. **Competitor Comparison** — Keywords: "Breville", "La Marzocco", "Rocket",
    "Sage", "DeLonghi", "Gaggia". Provide honest comparison showing Arco
    strengths without disparaging competitors.
13. **Arco Model Comparison** — Detect when the user mentions two or more Arco
    model names (e.g. "Primo vs Doppio"), or uses "compare" / "difference
    between". **MUST** include **best-pick** + **comparison-table**.

## Output Format

Return valid JSON with the following shape:

\`\`\`json
{
  "reasoning": "Brief explanation of why you chose these blocks.",
  "blocks": [
    {
      "type": "<block-name>",
      "priority": <1-10>,
      "content": { ... }
    }
  ]
}
\`\`\`

**ALWAYS** include a \`follow-up\` block as the very last block.
`;

/* -------------------------------------------------------------------------- */
/*  Detection Helpers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Returns true when the query looks like a comparison between two or more
 * Arco models or explicitly asks to compare.
 */
export function detectComparisonQuery(query: string): boolean {
  const lower = query.toLowerCase();

  // Explicit comparison keywords
  const comparisonKeywords = [
    'compare',
    'comparison',
    'difference between',
    'differences between',
    'vs',
    'versus',
    'or the',
    'which is better',
    'which one',
    'which should',
  ];
  const hasComparisonKeyword = comparisonKeywords.some((kw) => lower.includes(kw));

  // Count distinct model mentions
  const mentionedModels = new Set<string>();
  for (const pattern of MODEL_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    if (pattern.test(lower)) {
      // Normalise to a canonical key
      const key = lower.match(pattern)?.[0]?.replace(/\s+/g, '-').toLowerCase();
      if (key) mentionedModels.add(key);
    }
  }

  // Two or more models, or one model with an explicit comparison keyword
  return mentionedModels.size >= 2 || (mentionedModels.size >= 1 && hasComparisonKeyword);
}

/**
 * Extracts the Arco model names referenced in a query so the caller can
 * fetch the right product details from the content service.
 */
export function getComparisonDetails(query: string): string[] {
  const lower = query.toLowerCase();
  const found: string[] = [];

  for (const model of ARCO_MODELS) {
    const pattern = new RegExp(`\\b${model.replace('-', '\\s*-?\\s*')}\\b`, 'gi');
    if (pattern.test(lower) && !found.includes(model)) {
      found.push(model);
    }
  }
  return found;
}

/* -------------------------------------------------------------------------- */
/*  Prompt Builder                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Constructs the full reasoning prompt sent to the model by combining the
 * system prompt, optional RAG context, and the user's query.
 */
export function buildReasoningPrompt(
  userQuery: UserQuery,
  ragContext?: RAGContext,
): { system: string; user: string } {
  let contextSection = '';

  if (ragContext) {
    const productSnippets = (ragContext.relevantProducts ?? [])
      .map(
        (p) => `- **${p.name}** (${p.series}): ${p.description ?? ''}`,
      )
      .join('\n');

    const guideSnippets = (ragContext.relevantBrewGuides ?? [])
      .map((g) => `- ${g.name}: ${g.description ?? ''}`)
      .join('\n');

    if (productSnippets || guideSnippets) {
      contextSection = `\n## Relevant Context\n`;
      if (productSnippets) {
        contextSection += `\n### Products\n${productSnippets}\n`;
      }
      if (guideSnippets) {
        contextSection += `\n### Brew Guides\n${guideSnippets}\n`;
      }
    }
  }

  const comparisonModels = getComparisonDetails(userQuery.text);
  let comparisonHint = '';
  if (comparisonModels.length >= 2) {
    comparisonHint = `\n\n**The user is comparing Arco models: ${comparisonModels.join(', ')}.**
You MUST include a \`best-pick\` block followed by a \`comparison-table\` block.`;
  }

  const user = `${contextSection}

## User Query
"${userQuery.text}"
${comparisonHint}

Analyse the query, decide on the best blocks, and respond with valid JSON only.`;

  return { system: REASONING_SYSTEM_PROMPT, user };
}

/* -------------------------------------------------------------------------- */
/*  Response Parser                                                            */
/* -------------------------------------------------------------------------- */

interface RawReasoningResponse {
  reasoning?: string;
  blocks?: Array<{
    type?: string;
    priority?: number;
    content?: Record<string, unknown>;
  }>;
}

/**
 * Parses the raw LLM text output into a structured `ReasoningResult`.
 * Handles markdown-wrapped JSON (```json ... ```) and bare JSON.
 */
export function parseReasoningResponse(raw: string): ReasoningResult {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    cleaned = fenceMatch[1].trim();
  }

  let parsed: RawReasoningResponse;
  try {
    parsed = JSON.parse(cleaned) as RawReasoningResponse;
  } catch {
    // Last resort: try to extract a JSON object from the string
    const objectMatch = cleaned.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      parsed = JSON.parse(objectMatch[0]) as RawReasoningResponse;
    } else {
      throw new Error('Failed to parse reasoning response as JSON');
    }
  }

  const blocks: BlockRecommendation[] = (parsed.blocks ?? []).map((b) => ({
    type: normalizeBlockType(b.type ?? 'text'),
    priority: typeof b.priority === 'number' ? b.priority : 5,
    content: b.content ?? {},
  }));

  return {
    reasoning: parsed.reasoning ?? '',
    blocks,
  };
}

/* -------------------------------------------------------------------------- */
/*  Block Normalisation                                                        */
/* -------------------------------------------------------------------------- */

/** Map of common aliases or legacy names to canonical Arco block names. */
const BLOCK_TYPE_ALIASES: Record<string, string> = {
  'product-cards': 'cards',
  'product-card': 'cards',
  faq: 'accordion',
  'specs-table': 'table',
  specs: 'table',
  'feature-list': 'feature-highlights',
  features: 'feature-highlights',
  'product-recommendation': 'cards',
  'product-recommendations': 'cards',
  reviews: 'testimonials',
  review: 'testimonials',
  testimonial: 'testimonials',
  banner: 'hero',
  suggestions: 'follow-up',
  'follow-ups': 'follow-up',
  'next-steps': 'follow-up',
  comparison: 'comparison-table',
  'side-by-side': 'comparison-table',
  'use-cases': 'use-case-cards',
  'use-case': 'use-case-cards',
  answer: 'quick-answer',
  support: 'support-triage',
  budget: 'budget-breakdown',
  pricing: 'budget-breakdown',
  pick: 'best-pick',
  'top-pick': 'best-pick',
  recommendation: 'best-pick',
};

const VALID_BLOCK_TYPES = new Set([
  'hero',
  'cards',
  'columns',
  'accordion',
  'tabs',
  'table',
  'testimonials',
  'product-detail',
  'product-list',
  'carousel',
  'quote',
  'video',
  'quiz',
  'follow-up',
  'quick-answer',
  'support-triage',
  'budget-breakdown',
  'best-pick',
  'comparison-table',
  'feature-highlights',
  'use-case-cards',
  'text',
]);

/**
 * Normalises an arbitrary block type string to one of the canonical Arco
 * block names, falling back to `"text"` for anything unrecognised.
 */
export function normalizeBlockType(type: string): string {
  const lower = type.toLowerCase().trim();
  if (VALID_BLOCK_TYPES.has(lower)) return lower;
  if (BLOCK_TYPE_ALIASES[lower]) return BLOCK_TYPE_ALIASES[lower];
  return 'text';
}

/* -------------------------------------------------------------------------- */
/*  Block Post-Processing                                                      */
/* -------------------------------------------------------------------------- */

/**
 * If a hero block also contains embedded product recommendation data, split
 * it into a dedicated hero and a separate cards block so the front-end
 * renderer can handle each independently.
 */
export function separateHeroAndProductRecommendation(
  blocks: BlockRecommendation[],
): BlockRecommendation[] {
  const result: BlockRecommendation[] = [];

  for (const block of blocks) {
    if (block.type === 'hero' && block.content?.products) {
      // Extract product data into a new cards block
      const { products, ...heroContent } = block.content as Record<string, unknown>;
      result.push({ ...block, content: heroContent });
      result.push({
        type: 'cards',
        priority: block.priority - 1,
        content: { products },
      });
    } else {
      result.push(block);
    }
  }

  return result;
}

/**
 * Ensures every response contains a `follow-up` block at the end.
 * If no follow-up block exists it appends a sensible default.
 */
export function ensureRequiredBlocks(
  blocks: BlockRecommendation[],
  userQuery: UserQuery,
): BlockRecommendation[] {
  const hasFollowUp = blocks.some((b) => b.type === 'follow-up');

  if (!hasFollowUp) {
    blocks.push({
      type: 'follow-up',
      priority: 1,
      content: {
        suggestions: getDefaultFollowUpSuggestions(userQuery),
      },
    });
  } else {
    // Move follow-up to end if it is not already there
    const idx = blocks.findIndex((b) => b.type === 'follow-up');
    if (idx !== -1 && idx !== blocks.length - 1) {
      const [followUp] = blocks.splice(idx, 1);
      blocks.push(followUp);
    }
  }

  // Ensure comparison queries have mandatory blocks
  if (detectComparisonQuery(userQuery.text)) {
    const hasBestPick = blocks.some((b) => b.type === 'best-pick');
    const hasComparisonTable = blocks.some((b) => b.type === 'comparison-table');

    if (!hasBestPick) {
      // Insert best-pick before comparison-table or before follow-up
      const insertIdx = blocks.findIndex(
        (b) => b.type === 'comparison-table' || b.type === 'follow-up',
      );
      blocks.splice(insertIdx === -1 ? blocks.length - 1 : insertIdx, 0, {
        type: 'best-pick',
        priority: 9,
        content: {
          models: getComparisonDetails(userQuery.text),
        },
      });
    }

    if (!hasComparisonTable) {
      // Insert comparison-table before follow-up
      const followUpIdx = blocks.findIndex((b) => b.type === 'follow-up');
      blocks.splice(followUpIdx === -1 ? blocks.length : followUpIdx, 0, {
        type: 'comparison-table',
        priority: 8,
        content: {
          models: getComparisonDetails(userQuery.text),
        },
      });
    }
  }

  return blocks;
}

/* -------------------------------------------------------------------------- */
/*  Default Follow-Up Suggestions                                              */
/* -------------------------------------------------------------------------- */

function getDefaultFollowUpSuggestions(userQuery: UserQuery): string[] {
  const lower = userQuery.text.toLowerCase();

  // Contextual defaults based on query theme
  if (/grind|burr|grinder|macinino|preciso/i.test(lower)) {
    return [
      'What grind size should I use for espresso?',
      'Compare Macinino vs Preciso',
      'How often should I clean my grinder?',
    ];
  }

  if (/latte|milk|steam|cappuccino|flat white/i.test(lower)) {
    return [
      'How do I steam milk for latte art?',
      'Which Arco machine has the best steam wand?',
      'Compare Primo vs Doppio for milk drinks',
    ];
  }

  if (/travel|portable|viaggio|camping/i.test(lower)) {
    return [
      'Tell me more about the Viaggio',
      'What accessories do I need for travel espresso?',
      'Compare Viaggio vs Nano',
    ];
  }

  // Generic coffee-oriented defaults
  return [
    'Tell me more about Arco espresso machines',
    "What's the best grinder for espresso?",
    'Compare Primo vs Doppio',
  ];
}

/* -------------------------------------------------------------------------- */
/*  Main Entry Point                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The primary reasoning function. Takes a user query and optional RAG context,
 * calls the LLM, and returns a fully post-processed `ReasoningResult`.
 */
export async function analyzeAndSelectBlocks(
  userQuery: UserQuery,
  ragContext?: RAGContext,
): Promise<ReasoningResult> {
  const modelFactory = new GoogleModelFactory();
  const { system, user } = buildReasoningPrompt(userQuery, ragContext);

  try {
    const response = await modelFactory.call('reasoning', [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]);

    const rawText = response?.content ?? '';
    if (!rawText) {
      return getFallbackReasoningResult(userQuery);
    }

    const result = parseReasoningResponse(rawText);

    // Post-process
    result.blocks = separateHeroAndProductRecommendation(result.blocks);
    result.blocks = ensureRequiredBlocks(result.blocks, userQuery);

    return result;
  } catch (error) {
    console.error('[reasoning-engine] LLM call failed, using fallback:', error);
    return getFallbackReasoningResult(userQuery);
  }
}

/* -------------------------------------------------------------------------- */
/*  Fallback                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Returns a safe, pre-built reasoning result when the LLM call fails or
 * returns unparseable output.
 */
export function getFallbackReasoningResult(userQuery: UserQuery): ReasoningResult {
  const lower = userQuery.text.toLowerCase();
  const blocks: BlockRecommendation[] = [];

  // Rule 1 — Support / Frustrated
  if (/problem|broken|leaking|warranty|return|not working/i.test(lower)) {
    blocks.push({
      type: 'support-triage',
      priority: 10,
      content: { query: userQuery.text },
    });
  }

  // Rule 2 — Yes/No quick answer
  if (/^(can arco|will it|does it|is it worth|should i)\b/i.test(lower)) {
    blocks.push({
      type: 'quick-answer',
      priority: 10,
      content: { query: userQuery.text },
    });
  }

  // Rule 3 — Beginner
  if (
    /first espresso machine|switching from pods|never made espresso|beginner|new to espresso|nespresso/i.test(
      lower,
    )
  ) {
    blocks.push({
      type: 'hero',
      priority: 9,
      content: {
        headline: 'Welcome to the World of Real Espresso',
        subheadline:
          'Making the switch is easier than you think. Let us find the perfect machine for you.',
      },
    });
    blocks.push({
      type: 'cards',
      priority: 8,
      content: { filter: 'beginner-friendly' },
    });
  }

  // Rule 4 — Budget
  if (/budget|afford|cheap|worth it|student|expensive/i.test(lower)) {
    blocks.push({
      type: 'budget-breakdown',
      priority: 9,
      content: { query: userQuery.text },
    });
  }

  // Rule 5 — Gift
  if (/gift|birthday|wedding|christmas/i.test(lower)) {
    blocks.push({
      type: 'hero',
      priority: 9,
      content: {
        headline: 'The Perfect Coffee Gift',
        subheadline: 'Find an Arco machine they will love.',
      },
    });
    blocks.push({
      type: 'cards',
      priority: 8,
      content: { filter: 'gift-worthy' },
    });
  }

  // Rule 6 — Office / Commercial
  if (/restaurant|office|commercial|business|professional/i.test(lower)) {
    blocks.push({
      type: 'cards',
      priority: 9,
      content: { filter: 'commercial' },
    });
    blocks.push({
      type: 'table',
      priority: 8,
      content: { category: 'commercial-specs' },
    });
  }

  // Rule 7 — Travel / Portable
  if (/travel|portable|camping|take with me/i.test(lower)) {
    blocks.push({
      type: 'product-detail',
      priority: 9,
      content: { model: 'viaggio' },
    });
  }

  // Rule 8 — Upgrade
  if (/outgrown|upgrade|pod machine|better than|step up/i.test(lower)) {
    blocks.push({
      type: 'comparison-table',
      priority: 9,
      content: { query: userQuery.text },
    });
  }

  // Rule 9 — Grinder
  if (/grind size|burr|retention|single dose|flat vs conical/i.test(lower)) {
    blocks.push({
      type: 'feature-highlights',
      priority: 9,
      content: { category: 'grinders' },
    });
    blocks.push({
      type: 'table',
      priority: 8,
      content: { category: 'grinder-specs' },
    });
  }

  // Rule 10 — Latte Art
  if (/microfoam|milk steaming|latte art|flat white|steam wand/i.test(lower)) {
    blocks.push({
      type: 'feature-highlights',
      priority: 9,
      content: { focus: 'steam-and-milk' },
    });
    blocks.push({
      type: 'video',
      priority: 7,
      content: { topic: 'latte-art-tutorial' },
    });
  }

  // Rule 11 — Maintenance
  if (/descaling|backflush|cleaning|maintenance/i.test(lower)) {
    blocks.push({
      type: 'accordion',
      priority: 9,
      content: { category: 'maintenance' },
    });
    blocks.push({
      type: 'video',
      priority: 7,
      content: { topic: 'maintenance-guide' },
    });
  }

  // Rule 12 — Competitor Comparison
  if (/breville|la marzocco|rocket|sage|delonghi|gaggia/i.test(lower)) {
    blocks.push({
      type: 'comparison-table',
      priority: 9,
      content: { query: userQuery.text, type: 'competitor' },
    });
  }

  // Rule 13 — Arco Model Comparison (mandatory blocks)
  if (detectComparisonQuery(userQuery.text)) {
    const models = getComparisonDetails(userQuery.text);
    const hasBestPick = blocks.some((b) => b.type === 'best-pick');
    const hasComparisonTable = blocks.some((b) => b.type === 'comparison-table');

    if (!hasBestPick) {
      blocks.push({
        type: 'best-pick',
        priority: 10,
        content: { models },
      });
    }
    if (!hasComparisonTable) {
      blocks.push({
        type: 'comparison-table',
        priority: 9,
        content: { models },
      });
    }
  }

  // If nothing matched, provide a generic helpful response
  if (blocks.length === 0) {
    blocks.push({
      type: 'hero',
      priority: 8,
      content: {
        headline: 'Discover Arco Coffee Equipment',
        subheadline:
          'From beginner-friendly machines to professional-grade setups, find the perfect equipment for your coffee journey.',
      },
    });
    blocks.push({
      type: 'cards',
      priority: 7,
      content: { filter: 'popular' },
    });
    blocks.push({
      type: 'accordion',
      priority: 5,
      content: { category: 'general-faq' },
    });
  }

  // Always end with follow-up
  blocks.push({
    type: 'follow-up',
    priority: 1,
    content: {
      suggestions: getDefaultFollowUpSuggestions(userQuery),
    },
  });

  return {
    reasoning:
      'Fallback reasoning: LLM was unavailable. Blocks were selected using keyword rules.',
    blocks,
  };
}

/* -------------------------------------------------------------------------- */
/*  Display Formatter                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Produces a human-readable summary of a `ReasoningResult` for logging,
 * debugging, or preview purposes.
 */
export function formatReasoningForDisplay(result: ReasoningResult): string {
  const lines: string[] = [];

  lines.push('=== Reasoning Engine Output ===');
  lines.push('');
  lines.push(`Reasoning: ${result.reasoning}`);
  lines.push('');
  lines.push(`Blocks (${result.blocks.length}):`);

  for (const block of result.blocks) {
    const contentKeys = Object.keys(block.content ?? {}).join(', ');
    lines.push(
      `  [${block.priority.toString().padStart(2, ' ')}] ${block.type}${contentKeys ? ` (${contentKeys})` : ''}`,
    );
  }

  lines.push('');
  lines.push('===============================');

  return lines.join('\n');
}
