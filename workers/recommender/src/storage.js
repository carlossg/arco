/**
 * StorageManager — persists every recommender generation to D1 + KV.
 *
 * D1 (SESSIONS_DB): queryable session/page metadata (small, fast)
 * KV (SESSION_STORE): full page payloads — blocks HTML + debug snapshot (large)
 *
 * Key schema:
 *   sessions(id, ip_hash, user_agent, first_seen, last_seen, page_count)
 *   generated_pages(id, session_id, query, ...)
 *   KV key: "page:{pageId}" → JSON { blocks, debug, request }
 */

/**
 * Hash an IP address using SHA-256 (one-way, privacy-preserving).
 */
async function hashIp(ip) {
  const data = new TextEncoder().encode(ip || 'unknown');
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Upsert a session record. Creates on first visit, updates last_seen + page_count on repeat.
 */
async function upsertSession(db, sessionId, ipHash, headers, now) {
  const userAgent = (headers?.get?.('user-agent') || '').substring(0, 200);

  await db.prepare(`
    INSERT INTO sessions (id, ip_hash, user_agent, first_seen, last_seen, page_count)
    VALUES (?1, ?2, ?3, ?4, ?4, 1)
    ON CONFLICT(id) DO UPDATE SET
      last_seen = ?4,
      page_count = page_count + 1
  `).bind(sessionId, ipHash, userAgent, now).run();
}

/**
 * Insert a generated_pages record from pipeline context.
 */
async function insertPage(db, pageId, sessionId, ctx, now) {
  const intentType = ctx.intent?.type || null;
  const journeyStage = ctx.request?.inferredProfile?.journeyStage || null;
  const followUpType = ctx.request?.followUp?.type || null;
  const prevQueries = ctx.request?.previousQueries?.length
    ? JSON.stringify(ctx.request.previousQueries)
    : null;
  const title = ctx.llm?.sections?.[0]
    ? (() => {
      const h1 = ctx.llm.sections[0].match(/<h1[^>]*>([^<]+)<\/h1>/i);
      if (h1) return h1[1].substring(0, 200);
      const h2 = ctx.llm.sections[0].match(/<h2[^>]*>([^<]+)<\/h2>/i);
      return h2 ? h2[1].substring(0, 200) : null;
    })()
    : null;

  const durationMs = ctx.timings?.start ? Date.now() - ctx.timings.start : null;
  const inputTokens = ctx.llm?.usage?.prompt_tokens || null;
  const outputTokens = ctx.llm?.usage?.completion_tokens || null;
  const blockCount = ctx.llm?.sections?.length || 0;

  await db.prepare(`
    INSERT INTO generated_pages
      (id, session_id, query, previous_queries, title, intent_type, journey_stage,
       flow_id, follow_up_type, block_count, created_at, duration_ms,
       input_tokens, output_tokens, da_path, preview_url, live_url)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
  `).bind(
    pageId,
    sessionId,
    ctx.request.query.substring(0, 500),
    prevQueries,
    title,
    intentType,
    journeyStage,
    ctx.flowId || null,
    followUpType,
    blockCount,
    now,
    durationMs,
    inputTokens,
    outputTokens,
    ctx.daPath || null,
    ctx.daUrls?.preview || null,
    ctx.daUrls?.live || null,
  ).run();
}

/**
 * Build a compact debug snapshot from the pipeline context.
 * Captures intent, RAG summary, behaviour analysis, prompt sizes, timings, and LLM output.
 */
function buildDebugSnapshot(ctx) {
  return {
    intent: ctx.intent || null,
    behaviorAnalysis: ctx.rag?.behaviorAnalysis || null,
    rag: {
      products: (ctx.rag?.products || []).map((p) => ({
        id: p.id, name: p.name, score: p.score, price: p.price,
      })),
      features: (ctx.rag?.features || []).map((f) => ({ name: f.name, benefit: f.benefit })),
      faqs: (ctx.rag?.faqs || []).map((f) => ({ question: f.question?.substring(0, 100) })),
      reviews: (ctx.rag?.reviews || []).map((r) => ({ author: r.author, productId: r.productId })),
      // eslint-disable-next-line no-underscore-dangle
      recipes: (ctx.rag?.recipes || []).map((r) => ({
        name: r.name, slug: r.slug, score: r._score, // eslint-disable-line no-underscore-dangle
      })),
      persona: ctx.rag?.persona
        ? { name: ctx.rag.persona.name, slug: ctx.rag.persona.slug } : null,
      useCase: ctx.rag?.useCase
        ? { id: ctx.rag.useCase.id, name: ctx.rag.useCase.name } : null,
      heroImages: (ctx.rag?.heroImages || []).slice(0, 5).map((h) => ({
        id: h.id, score: h.score, url: h.url,
      })),
    },
    prompt: {
      systemLength: ctx.prompt?.system?.length || 0,
      userLength: ctx.prompt?.user?.length || 0,
      systemPrompt: ctx.prompt?.system || '',
      userMessage: ctx.prompt?.user || '',
    },
    timings: ctx.timings || {},
    llm: {
      model: ctx.llm?.model || null,
      inputTokens: ctx.llm?.usage?.prompt_tokens || null,
      outputTokens: ctx.llm?.usage?.completion_tokens || null,
      rawOutput: ctx.llm?.fullText || '',
      jsonSections: ctx.llm?.rawJsonSections || [],
      suggestions: ctx.llm?.suggestions || [],
    },
    contentStrategy: ctx.contentStrategy || null,
    qualityScore: ctx.qualityScore || null,
  };
}

/**
 * Save a completed generation to D1 + KV.
 * Called fire-and-forget after the stream closes.
 *
 * @param {object} ctx    Pipeline context (after executeFlow completes)
 * @param {object} env    Worker env (SESSIONS_DB, SESSION_STORE bindings)
 * @param {string} sessionId  Client-provided session UUID
 * @returns {Promise<string>} The generated pageId
 */
// eslint-disable-next-line import/prefer-default-export
export async function saveGeneration(ctx, env, sessionId) {
  if (!env.SESSIONS_DB || !env.SESSION_STORE) return null;

  const pageId = crypto.randomUUID();
  const now = Date.now();

  try {
    const ipHash = await hashIp(ctx.request?.ip);

    // 1. Upsert session
    await upsertSession(env.SESSIONS_DB, sessionId, ipHash, ctx.request?.headers, now);

    // 2. Insert page metadata
    await insertPage(env.SESSIONS_DB, pageId, sessionId, ctx, now);

    // 3. Store full payload in KV (90-day retention)
    const payload = {
      pageId,
      sessionId,
      blocks: (ctx.llm?.sections || []).map((html, i) => ({
        index: i,
        blockType: ctx.llm?.rawJsonSections?.[i]?.block || 'unknown',
        html,
      })),
      debug: buildDebugSnapshot(ctx),
      request: {
        query: ctx.request?.query,
        previousQueries: ctx.request?.previousQueries || [],
        browsingHistory: ctx.request?.browsingHistory || [],
        inferredProfile: ctx.request?.inferredProfile || null,
        behaviorProfile: ctx.request?.behaviorProfile || null,
        quizPersona: ctx.request?.quizPersona || null,
        followUp: ctx.request?.followUp || null,
      },
    };

    await env.SESSION_STORE.put(`page:${pageId}`, JSON.stringify(payload), {
      expirationTtl: 60 * 60 * 24 * 90, // 90 days
    });

    return pageId;
  } catch (err) {
    // Storage failures must never break the user-facing response
    console.error('[Storage] saveGeneration failed:', err.message);
    return null;
  }
}
