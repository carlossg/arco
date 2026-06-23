/**
 * Runtime LLM configuration — active provider/model + generation params.
 * Stored in CACHE KV under `llm-config:active`. Falls back to flow defaults
 * and, ultimately, the first catalog entry.
 */

import { findCatalogEntry, DEFAULT_CATALOG_ENTRY } from './providers/index.js';

const KV_KEY = 'llm-config:active';

const TEMP_MIN = 0;
const TEMP_MAX = 2;
const TOKENS_MIN = 256;
const TOKENS_MAX = 16384;

function clamp(n, min, max) {
  if (typeof n !== 'number' || Number.isNaN(n)) return null;
  return Math.max(min, Math.min(max, n));
}

/**
 * Local-dev default: when no KV config is stored but OLLAMA_MODEL is set in the
 * environment (typically via .dev.vars during `wrangler dev`), route the main
 * pipeline to the local Ollama server with zero clicks. A KV entry written via
 * admin Model Settings still takes precedence. Returns null in production where
 * OLLAMA_MODEL is unset.
 */
function ollamaEnvDefault(env) {
  if (!env?.OLLAMA_MODEL) return null;
  // Reasoning-capable Ollama models spend output budget on a thinking phase
  // before emitting page content, so the flow default (5120) can be fully
  // consumed by thinking and yield an empty page. Default Ollama to a larger
  // budget, overridable via OLLAMA_MAX_TOKENS.
  const parsed = parseInt(env.OLLAMA_MAX_TOKENS, 10);
  const maxTokens = Number.isFinite(parsed) && parsed > 0 ? parsed : 16384;
  return {
    provider: 'ollama',
    model: env.OLLAMA_MODEL,
    temperature: null,
    maxTokens,
    thinking: String(env.OLLAMA_THINK).toLowerCase() === 'false' ? false : null,
    updatedAt: null,
  };
}

/**
 * Read the active LLM config from KV. Falls back to the Ollama env default (see
 * ollamaEnvDefault) on miss, otherwise null if the stored entry is unusable.
 */
export async function getActiveLlmConfig(env) {
  if (!env.CACHE) return ollamaEnvDefault(env);
  let stored;
  try {
    stored = await env.CACHE.get(KV_KEY, 'json');
  } catch {
    return ollamaEnvDefault(env);
  }
  if (!stored || !stored.provider || !stored.model) return ollamaEnvDefault(env);
  if (!findCatalogEntry(stored.provider, stored.model)) {
    console.warn(`[llm-config] stored entry not in catalog: ${stored.provider}/${stored.model}`);
    return ollamaEnvDefault(env);
  }
  return {
    provider: stored.provider,
    model: stored.model,
    temperature: typeof stored.temperature === 'number' ? stored.temperature : null,
    maxTokens: typeof stored.maxTokens === 'number' ? stored.maxTokens : null,
    thinking: typeof stored.thinking === 'boolean' ? stored.thinking : null,
    updatedAt: stored.updatedAt || null,
  };
}

/**
 * Validate + persist an LLM config patch. Returns the stored value on success
 * or { error } on validation failure.
 */
export async function putActiveLlmConfig(env, patch) {
  if (!env.CACHE) return { error: 'CACHE KV binding is not configured.' };
  if (!patch || typeof patch !== 'object') return { error: 'Invalid body.' };
  const entry = findCatalogEntry(patch.provider, patch.model);
  if (!entry) return { error: `Unknown provider/model: ${patch.provider}/${patch.model}` };

  const temperature = clamp(patch.temperature, TEMP_MIN, TEMP_MAX);
  const maxTokens = patch.maxTokens != null
    ? clamp(Math.round(patch.maxTokens), TOKENS_MIN, TOKENS_MAX)
    : null;

  // Tri-state reasoning toggle: true = force on, false = force off, null = use
  // the model/provider default. Interpreted by providers that support it
  // (Ollama `think`, Cloudflare `enable_thinking`).
  let thinking = null;
  if (patch.thinking === true || patch.thinking === false) thinking = patch.thinking;

  const value = {
    provider: entry.provider,
    model: entry.model,
    temperature,
    maxTokens,
    thinking,
    updatedAt: new Date().toISOString(),
  };

  await env.CACHE.put(KV_KEY, JSON.stringify(value));
  return { value };
}

export function resolveLlmConfig(active, flowConfig) {
  const provider = active?.provider || 'cerebras';
  const model = active?.model || flowConfig?.model || DEFAULT_CATALOG_ENTRY.model;
  const temperature = active?.temperature
    ?? (typeof flowConfig?.temperature === 'number' ? flowConfig.temperature : 0.6);
  const maxTokens = active?.maxTokens ?? flowConfig?.maxTokens ?? 4096;
  const thinking = typeof active?.thinking === 'boolean' ? active.thinking : null;
  return {
    provider, model, temperature, maxTokens, thinking,
  };
}

export const LLM_CONFIG_LIMITS = {
  temperature: { min: TEMP_MIN, max: TEMP_MAX },
  maxTokens: { min: TOKENS_MIN, max: TOKENS_MAX },
};
