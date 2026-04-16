/**
 * Intent Classify Step — rule-based query intent classification for coffee equipment.
 * Writes ctx.intent = { type, confidence, journeyStage }.
 */

const ESPRESSO_KEYWORDS = [
  'espresso', 'shot', 'crema', 'extraction', 'pull', 'dial in', 'dial-in',
  'dose', 'yield', 'channeling', 'bottomless', 'naked portafilter',
];

const MILK_KEYWORDS = [
  'latte', 'cappuccino', 'flat white', 'cortado', 'milk', 'foam',
  'microfoam', 'steam', 'latte art', 'rosetta', 'tulip',
];

const GRINDER_KEYWORDS = [
  'grind', 'grinder', 'burr', 'conical', 'flat burr', 'retention',
  'distribution', 'wdt', 'single dose', 'single-dose', 'dose',
];

const COMPARE_KEYWORDS = [
  'compare', 'comparison', 'versus', 'vs', 'difference', 'differences',
  'better', 'which one', 'which is',
];

const BUDGET_KEYWORDS = [
  'price', 'cost', 'budget', 'affordable', 'cheap', 'value', 'under',
  'save', 'expensive', 'worth it', 'student',
];

const GIFT_KEYWORDS = [
  'gift', 'present', 'birthday', 'wedding', 'holiday', 'christmas',
  'housewarming', 'mother', 'father', 'anniversary',
];

const UPGRADE_KEYWORDS = [
  'upgrade', 'improve', 'next level', 'step up', 'outgrow', 'replace',
  'prosumer', 'better than', 'switch from',
];

const TRAVEL_KEYWORDS = [
  'travel', 'portable', 'camping', 'hotel', 'carry-on', 'lightweight',
  'compact', 'on the go', 'mobile',
];

const SUPPORT_KEYWORDS = [
  'help', 'support', 'troubleshoot', 'fix', 'problem', 'issue',
  'warranty', 'repair', 'clean', 'cleaning', 'maintenance', 'descale',
  'descaling', 'backflush',
];

const POUR_OVER_KEYWORDS = [
  'pour over', 'pour-over', 'filter', 'drip', 'v60', 'chemex',
  'cold brew', 'single origin', 'aeropress', 'french press',
];

const BEGINNER_KEYWORDS = [
  'beginner', 'first', 'new to', 'never made', 'starting', 'learn',
  'getting started', 'what do i need',
];

function classifyType(query) {
  const q = query.toLowerCase();
  const scores = {
    espresso: 0,
    'milk-drinks': 0,
    'grinder-focused': 0,
    comparison: 0,
    'product-discovery': 0,
    budget: 0,
    gift: 0,
    upgrade: 0,
    travel: 0,
    support: 0,
    'pour-over': 0,
    beginner: 0,
    general: 0,
  };

  ESPRESSO_KEYWORDS.forEach((kw) => { if (q.includes(kw)) scores.espresso += 2; });
  MILK_KEYWORDS.forEach((kw) => { if (q.includes(kw)) scores['milk-drinks'] += 2; });
  GRINDER_KEYWORDS.forEach((kw) => { if (q.includes(kw)) scores['grinder-focused'] += 2; });
  COMPARE_KEYWORDS.forEach((kw) => { if (q.includes(kw)) scores.comparison += 3; });
  BUDGET_KEYWORDS.forEach((kw) => { if (q.includes(kw)) scores.budget += 2; });
  GIFT_KEYWORDS.forEach((kw) => { if (q.includes(kw)) scores.gift += 3; });
  UPGRADE_KEYWORDS.forEach((kw) => { if (q.includes(kw)) scores.upgrade += 2; });
  TRAVEL_KEYWORDS.forEach((kw) => { if (q.includes(kw)) scores.travel += 3; });
  SUPPORT_KEYWORDS.forEach((kw) => { if (q.includes(kw)) scores.support += 2; });
  POUR_OVER_KEYWORDS.forEach((kw) => { if (q.includes(kw)) scores['pour-over'] += 2; });
  BEGINNER_KEYWORDS.forEach((kw) => { if (q.includes(kw)) scores.beginner += 2; });

  // Check for specific Arco product names
  const PRODUCT_NAMES = ['primo', 'doppio', 'studio', 'studio pro', 'studio-pro',
    'nano', 'viaggio', 'automatico', 'ufficio', 'preciso', 'macinino', 'filtro', 'zero'];
  PRODUCT_NAMES.forEach((name) => { if (q.includes(name)) scores['product-discovery'] += 3; });

  // Boost comparison when compare keywords AND 2+ product names are present
  // (product-discovery score would otherwise outweigh comparison for queries like
  // "compare studio and studio pro" where each product name adds 3 points)
  if (scores.comparison > 0) {
    const mentionedProducts = PRODUCT_NAMES.filter((name) => q.includes(name));
    if (mentionedProducts.length >= 2) {
      scores.comparison += mentionedProducts.length * 3;
    }
  }

  let bestType = 'general';
  let bestScore = 0;
  Object.entries(scores).forEach(([type, score]) => {
    if (score > bestScore) {
      bestType = type;
      bestScore = score;
    }
  });

  return { type: bestType, confidence: bestScore > 0 ? Math.min(bestScore / 6, 1) : 0 };
}

function classifyJourneyStage(previousQueries, followUp) {
  if (followUp?.type === 'buy') return 'purchase';
  if (previousQueries && previousQueries.length >= 3) return 'decision';
  if (previousQueries && previousQueries.length >= 1) return 'consideration';
  return 'awareness';
}

// eslint-disable-next-line import/prefer-default-export
export async function intentClassify(ctx) {
  const start = Date.now();
  const { type, confidence } = classifyType(ctx.request.query);
  const journeyStage = classifyJourneyStage(
    ctx.request.previousQueries,
    ctx.request.followUp,
  );

  ctx.intent = { type, confidence, journeyStage };
  ctx.timings.intentClassify = Date.now() - start;
}
