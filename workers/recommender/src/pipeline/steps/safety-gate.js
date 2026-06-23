/**
 * Safety Gate Step — deterministic pre-RAG filter that rejects queries unrelated
 * to coffee, espresso machines, or the Arco product domain.
 *
 * Runs as a gate step: sets ctx.earlyResponse with a streaming NDJSON decline
 * so the client renders a friendly rejection page without burning RAG or LLM tokens.
 */

import { CORS_HEADERS } from '../context.js';

// --- Positive signals: if ANY of these match, the query is on-topic and passes through ---

// Core coffee/product terms — definitively on-topic regardless of other signals
const COFFEE_KEYWORDS = [
  'coffee', 'espresso', 'latte', 'cappuccino', 'americano', 'macchiato',
  'flat white', 'cortado', 'mocha', 'ristretto', 'lungo', 'doppio',
  'grind', 'grinder', 'burr', 'portafilter', 'tamper', 'tamp',
  'extraction', 'crema', 'puck',
  'milk', 'foam', 'microfoam', 'froth', 'latte art',
  'bean', 'roast', 'single origin', 'blend', 'arabica', 'robusta',
  'brew', 'brewing', 'pour over', 'pour-over', 'french press', 'aeropress',
  'v60', 'chemex', 'cold brew', 'moka',
  'barista', 'cafe', 'café', 'cafetiere',
  'descale', 'descaling', 'backflush',
  'boiler', 'dual boiler', 'heat exchanger', 'thermoblock',
  'pid', 'vibratory', 'rotary',
  'demitasse', 'knock box',
  'wdt', 'channeling',
  'arco', 'primo', 'studio', 'studio pro', 'nano', 'viaggio',
  'automatico', 'ufficio', 'preciso', 'macinino', 'filtro', 'zero',
];

// Shopping-intent words that are on-topic on a coffee equipment site,
// but too generic to override harmful/illegal signals on their own
const SHOPPING_KEYWORDS = [
  'gift', 'present', 'birthday', 'upgrade', 'buy', 'recommend',
  'beginner', 'starter', 'budget', 'affordable', 'compare',
  'machine', 'steam', 'cup', 'mug', 'shot', 'dose', 'yield',
  'pull', 'drip', 'filter', 'clean', 'maintenance', 'pump', 'bar',
  'pressure', 'distribution',
];

// --- Negative signals: categories of off-topic content ---

const CODE_KEYWORDS = [
  'javascript', 'python', 'java ', 'typescript', 'html', 'css',
  'react', 'angular', 'vue', 'node.js', 'nodejs',
  'function', 'variable', 'class ', 'import ', 'export ',
  'compile', 'compiler', 'debug', 'debugger', 'runtime',
  'api', 'endpoint', 'database', 'sql', 'mongodb',
  'git', 'github', 'docker', 'kubernetes', 'aws', 'azure',
  'algorithm', 'data structure', 'binary', 'recursion',
  'webpack', 'npm', 'yarn', 'pip', 'cargo',
  'code', 'programming', 'software', 'developer',
  'write me a', 'write a program', 'write a script',
  'fix my code', 'bug in my', 'syntax error',
];

const ILLEGAL_KEYWORDS = [
  'hack ', 'hacking', 'crack ', 'cracking', 'exploit', 'malware', 'virus',
  'trojan', 'phishing', 'ransomware', 'ddos', 'botnet',
  'steal ', 'stealing', 'fraud', 'scam', 'counterfeit', 'forgery',
  'drugs', 'narcotic', 'methamphetamine', 'cocaine', 'heroin', 'fentanyl',
  'weapon', 'bomb', 'explosive', 'firearm', 'ammunition',
  'launder', 'money laundering', 'tax evasion',
  'child abuse', 'trafficking', 'exploit children',
  'terroris', 'extremis',
];

const HARMFUL_KEYWORDS = [
  'suicide', 'self-harm', 'kill myself', 'end my life',
  'how to hurt', 'how to poison', 'how to stalk',
  'revenge porn', 'deepfake',
  'hate speech', 'racial slur',
];

const GENERAL_QA_PATTERNS = [
  'what is the capital of', 'who is the president',
  'what year did', 'when was', 'how tall is',
  'tell me about', 'explain the theory',
  'solve this equation', 'calculate',
  'translate', 'write an essay', 'write a story',
  'help me with my homework', 'exam question',
  'recipe for chicken', 'recipe for beef', 'recipe for pasta',
  'recipe for cake', 'recipe for soup',
  'how to lose weight', 'diet plan',
  'medical advice', 'diagnos',
  'legal advice', 'sue', 'lawyer',
  'stock market', 'cryptocurrency', 'bitcoin', 'invest in',
  'weather forecast', 'sports score',
];

function hasCoreSignal(query) {
  return COFFEE_KEYWORDS.some((kw) => query.includes(kw));
}

function hasShoppingSignal(query) {
  return SHOPPING_KEYWORDS.some((kw) => query.includes(kw));
}

function matchesCategory(query, keywords) {
  return keywords.some((kw) => query.includes(kw));
}

function isOffTopic(query) {
  const q = query.toLowerCase();
  const coreMatch = hasCoreSignal(q);

  // Harmful/illegal content is always blocked, even if coffee words are present
  if (matchesCategory(q, ILLEGAL_KEYWORDS) || matchesCategory(q, HARMFUL_KEYWORDS)) {
    return 'harmful';
  }

  // Core coffee terms override all softer negative categories
  if (coreMatch) return null;

  const isCode = matchesCategory(q, CODE_KEYWORDS);
  const isGeneral = matchesCategory(q, GENERAL_QA_PATTERNS);

  // Shopping-intent words pass only when no negative signal is present
  if (hasShoppingSignal(q) && !isCode && !isGeneral) return null;

  if (isCode) return 'code';
  if (isGeneral) return 'general';

  // No positive signal and no strong negative signal:
  // allow short ambiguous queries through (might be product names or slang)
  // but block longer queries that are clearly not about coffee
  const wordCount = q.split(/\s+/).length;
  if (wordCount >= 5) {
    return 'unrelated';
  }

  return null;
}

function buildDeclineResponse(category) {
  let message;
  let heading;

  switch (category) {
    case 'harmful':
      heading = 'I can\'t help with that';
      message = 'I\'m not able to assist with that type of request. I\'m here to help you find the perfect espresso setup — from choosing your first machine to dialing in the perfect shot.';
      break;
    case 'code':
      heading = 'That\'s outside my expertise';
      message = 'I\'m a specialty coffee advisor, not a coding assistant! I can\'t help with programming questions, but I\'d love to help you find the perfect espresso machine to fuel those coding sessions.';
      break;
    case 'general':
      heading = 'Let\'s talk coffee instead';
      message = 'I\'m your Arco coffee equipment advisor — I specialize in espresso machines, grinders, and everything that goes into making great coffee at home. I\'m not able to help with general questions, but I\'m here whenever you\'re ready to explore our lineup.';
      break;
    default:
      heading = 'Let me redirect you';
      message = 'I\'m focused exclusively on specialty coffee and Arco equipment. I can help you pick the right espresso machine, compare grinders, learn brewing techniques, or troubleshoot your setup — ask me anything coffee-related!';
  }

  const sectionHtml = `<div class="section"><div class="default-content-wrapper"><h2>${heading}</h2><p>${message}</p></div></div>`;

  const suggestions = category === 'harmful' ? [] : [
    { type: 'explore', label: 'Show me the Arco lineup' },
    { type: 'explore', label: 'Best machine for beginners' },
    { type: 'explore', label: 'Compare espresso machines' },
  ];

  return { sectionHtml, suggestions, heading };
}

// eslint-disable-next-line import/prefer-default-export
export async function safetyGate(ctx) {
  const start = Date.now();
  const { query } = ctx.request;

  const category = isOffTopic(query);
  ctx.timings.safetyGate = Date.now() - start;

  if (!category) return;

  const { sectionHtml, suggestions, heading } = buildDeclineResponse(category);

  const lines = [
    JSON.stringify({ type: 'section', index: 0, html: sectionHtml }),
    JSON.stringify({ type: 'suggestions', items: suggestions }),
    JSON.stringify({ type: 'done', title: heading, usedProducts: [] }),
  ];
  const body = lines.map((l) => `${l}\n`).join('');

  ctx.earlyResponse = new Response(body, {
    status: 200,
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
    },
  });
}
