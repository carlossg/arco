/**
 * /api/suggest — lightweight LLM-backed exploration suggestions.
 *
 * Used by the keep-exploring block to produce 1–3 personalized chip queries
 * based on the user's session browsing history. Decoupled from /api/generate
 * so it can run on a fast/cheap model, cap maxTokens at ~256, and skip
 * persistence + RAG entirely.
 */

import { CORS_HEADERS } from './pipeline/context.js';
import { getProvider, catalogAvailability, MODEL_CATALOG } from './providers/index.js';
import { writeEvent } from './analytics.js';
import { renderPrompt } from './prompt-loader.js';

const DEFAULT_PROVIDER = 'cerebras';
const DEFAULT_MODEL = 'llama3.1-8b';
const FALLBACK_PROVIDER = 'cloudflare';
const FALLBACK_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const CACHE_TTL_SECONDS = 300; // 5 min
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30; // per-IP per minute (loose; calls are cheap)

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

async function sha256Hex(input) {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Build a stable signature from the inputs that should drive cache hits.
 * Deliberately omits volatile fields (totalTimeOnSite, exact timestamps).
 */
async function buildCacheKey(body) {
  const profile = body?.context?.inferredProfile || {};
  const top3Categories = (profile.categoriesViewed || []).slice(0, 3).sort();
  const top3Products = (profile.productsViewed || []).slice(-3).sort();
  const exclude = [...(body.excludeQueries || [])].map((s) => s.toLowerCase()).sort();
  const sig = JSON.stringify({
    pageUrl: body.pageUrl || '',
    journeyStage: profile.journeyStage || '',
    categories: top3Categories,
    products: top3Products,
    exclude,
    count: body.count,
  });
  return `suggest:v1:${await sha256Hex(sig)}`;
}

/**
 * Drain a provider stream into a single text buffer + token usage.
 */
async function collectStream(provider, params) {
  let text = '';
  let usage = null;
  // eslint-disable-next-line no-restricted-syntax
  for await (const chunk of provider.stream(params)) {
    if (chunk.type === 'delta' && chunk.text) text += chunk.text;
    if (chunk.type === 'usage') usage = chunk.usage;
  }
  return { text, usage };
}

/**
 * Extract the first valid JSON object from an LLM text reply.
 */
function tryParseJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  // Strip markdown fences if present
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  const candidate = fenced ? fenced[1] : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    // Try first-{...}-balanced extraction
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch { /* fall through */ }
    }
    return null;
  }
}

/**
 * Validate parsed LLM output against the requested count and exclude list.
 */
function parseAndValidate(text, count, excludeQueries = []) {
  const parsed = tryParseJson(text);
  if (!parsed || !Array.isArray(parsed.suggestions)) return [];
  const excludeLower = new Set(excludeQueries.map((s) => String(s).toLowerCase()));
  const out = [];
  const seen = new Set();
  parsed.suggestions.forEach((s) => {
    const label = (s?.label || '').trim();
    const query = (s?.query || s?.label || '').trim();
    if (!label || label.length > 120) return;
    if (excludeLower.has(label.toLowerCase())) return;
    if (seen.has(label.toLowerCase())) return;
    seen.add(label.toLowerCase());
    out.push({ label, query });
  });
  return out.slice(0, count);
}

/**
 * Last-resort suggestions when the LLM fails or returns nothing usable.
 */
function genericFallback(body) {
  const title = (body.pageTitle || '').replace(/\s*\|\s*Arco$/i, '').trim();
  if (title) {
    return [
      { label: `More like ${title}`, query: `Show me more like ${title}` },
      { label: 'Best espresso machines', query: 'Best espresso machines' },
      { label: 'How to dial in espresso', query: 'How to dial in espresso' },
    ].slice(0, body.count || 3);
  }
  return [
    { label: 'Best espresso machines', query: 'Best espresso machines' },
    { label: 'Compare popular grinders', query: 'Compare popular grinders' },
    { label: 'How to dial in espresso', query: 'How to dial in espresso' },
  ].slice(0, body.count || 3);
}

/**
 * Loose IP-hashed rate limit. KV-backed; allows N calls per
 * RATE_LIMIT_WINDOW_MS. On KV errors, lets the request through (calls are
 * cheap and we'd rather degrade availability than fail closed).
 */
async function rateLimit(env, request) {
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'unknown';
  const ipHash = await sha256Hex(ip);
  const key = `suggest-rl:${ipHash}`;
  try {
    const raw = await env.CACHE.get(key, 'json');
    const now = Date.now();
    let record = raw && typeof raw === 'object' ? raw : { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    if (now >= record.resetAt) {
      record = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    }
    record.count += 1;
    await env.CACHE.put(key, JSON.stringify(record), {
      expirationTtl: Math.max(60, Math.ceil((record.resetAt - now) / 1000)),
    });
    if (record.count > RATE_LIMIT_MAX) return false;
  } catch {
    // KV failure — allow through
  }
  return true;
}

/**
 * Resolve provider+model for the suggest endpoint, with env override.
 * Falls back to cloudflare workers-AI if the primary is unavailable.
 */
function resolveModel(env) {
  const provider = env.SUGGEST_LLM_PROVIDER || DEFAULT_PROVIDER;
  const model = env.SUGGEST_LLM_MODEL || DEFAULT_MODEL;
  const entry = MODEL_CATALOG.find((e) => e.provider === provider && e.model === model)
    || { provider, model };
  const { available } = catalogAvailability(entry, env);
  if (available) return { provider, model };
  // Fallback
  const fb = { provider: FALLBACK_PROVIDER, model: FALLBACK_MODEL };
  const fbEntry = MODEL_CATALOG.find(
    (e) => e.provider === fb.provider && e.model === fb.model,
  ) || fb;
  if (catalogAvailability(fbEntry, env).available) return fb;
  return null;
}

export default async function handleSuggestRequest(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON body' }, 400);
  }

  const count = Math.min(3, Math.max(1, parseInt(body?.count, 10) || 3));
  body.count = count;
  body.pageUrl = typeof body.pageUrl === 'string' ? body.pageUrl : '';
  body.pageTitle = typeof body.pageTitle === 'string' ? body.pageTitle : '';
  body.excludeQueries = Array.isArray(body.excludeQueries) ? body.excludeQueries : [];

  if (!(await rateLimit(env, request))) {
    return jsonResponse({ error: 'Rate limit exceeded' }, 429);
  }

  // Cache check
  const cacheKey = await buildCacheKey(body);
  try {
    const cached = await env.CACHE?.get(cacheKey, 'json');
    if (cached && Array.isArray(cached.suggestions)) {
      return jsonResponse(cached);
    }
  } catch { /* CACHE missing — fall through */ }

  const resolved = resolveModel(env);
  if (!resolved) {
    return jsonResponse({ suggestions: genericFallback(body) });
  }

  let suggestions = [];
  let usage = null;
  try {
    const provider = getProvider(resolved.provider);
    const profile = body?.context?.inferredProfile || {};
    const { system, user } = renderPrompt('suggestions', {
      count,
      pageUrl: body.pageUrl || '',
      pageTitle: body.pageTitle || '',
      userProfile: {
        journeyStage: profile.journeyStage,
        inferredIntent: profile.inferredIntent,
        categories: (profile.categoriesViewed || []).slice(0, 5),
        interests: (profile.interests || []).slice(0, 5),
      },
      recentlyViewed: (profile.productsViewed || []).slice(-5),
      excludeQueries: body.excludeQueries || [],
    });

    const result = await collectStream(provider, {
      env,
      model: resolved.model,
      temperature: 0.7,
      maxTokens: 256,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    });
    usage = result.usage;
    suggestions = parseAndValidate(result.text, count, body.excludeQueries);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[suggest] LLM error:', error?.message || error);
  }

  const result = {
    suggestions: suggestions.length > 0 ? suggestions : genericFallback(body),
  };

  // Best-effort cache write
  try {
    await env.CACHE?.put(cacheKey, JSON.stringify(result), {
      expirationTtl: CACHE_TTL_SECONDS,
    });
  } catch { /* ignore */ }

  // Best-effort analytics ping (don't await — fire and forget)
  try {
    writeEvent(env, 'suggest_generated', 'suggest', '', body.pageUrl || '', {
      provider: resolved.provider,
      model: resolved.model,
      count: result.suggestions.length,
      tokens: usage?.total_tokens ?? null,
    });
  } catch { /* ignore */ }

  return jsonResponse(result);
}
