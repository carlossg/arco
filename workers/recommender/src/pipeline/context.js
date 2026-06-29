/**
 * Pipeline Context Factory — creates the shared mutable context
 * that flows through all pipeline steps.
 */

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Loadtest-Token, X-Skip-Cerebras, X-Skip-Pipeline',
};

/**
 * Create a new pipeline context from a parsed request body and request object.
 */
export function createContext(body, request) {
  const {
    query, context: reqContext, followUp, speculative, tv,
  } = body;
  // TV (10-foot) mode — also detect the Google TV WebView's user-agent and a
  // `tv` query param on the request URL, so the constraint holds even if the
  // client omits the body flag.
  const ua = request.headers.get('user-agent') || '';
  let tvParam = false;
  try {
    const tvQs = new URL(request.url).searchParams.get('tv');
    tvParam = tvQs === '1' || tvQs === 'true';
  } catch { /* request.url may be relative in tests */ }
  const tvMode = tv === true || /ArcoTV/i.test(ua) || tvParam;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const previousQueries = reqContext?.previousQueries || [];
  const browsingHistory = reqContext?.browsingHistory || [];
  const inferredProfile = reqContext?.inferredProfile || null;
  const behaviorProfile = reqContext?.behaviorProfile || null;
  const shownContent = reqContext?.shownContent || null;
  const quizPersona = reqContext?.quizPersona || null;

  return {
    // Immutable request data
    request: {
      query,
      previousQueries,
      browsingHistory,
      inferredProfile,
      behaviorProfile,
      followUp,
      shownContent,
      quizPersona,
      ip,
      speculative,
      tv: tvMode,
      headers: request.headers,
    },

    // TV (10-foot) mode — drives the `tv-comparison` flow + prompt scenario.
    tv: tvMode,

    // Flow metadata
    flowId: null,
    flowName: null,

    // Control flags
    earlyResponse: null,

    // Pre-processing results
    intent: null,

    // RAG results (each step writes its key)
    rag: {
      guides: [],
      experiences: [],
      products: [],
      features: [],
      faqs: [],
      reviews: [],
      recipes: [],
      comparisons: [],
      toolContent: [],
      persona: null,
      useCase: null,
      behaviorAnalysis: null,
    },

    // Generation
    prompt: { system: '', user: '' },
    llm: {
      fullText: '',
      sections: [],
      rawJsonSections: [],
      suggestions: [],
      usage: null,
    },

    // Streaming
    writer: null,
    encoder: null,

    // Diagnostics
    timings: { start: Date.now() },
    ndjsonLines: [],
  };
}
