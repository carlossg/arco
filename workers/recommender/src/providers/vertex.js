/**
 * Vertex AI provider — calls OpenAI-compatible /chat/completions on a
 * Model Garden vLLM dedicated endpoint.
 *
 * Auth: Authorization: Bearer {VERTEX_AI_TOKEN} (gcloud bearer token, 1h expiry).
 * Endpoint: dedicated DNS like
 *   https://mg-endpoint-ID.REGION-PROJECT.prediction.vertexai.goog/v1/projects/...
 * The model field is the numeric deployed-model ID (e.g. "2930507450790445056").
 *
 * Refresh the token hourly:
 *   wrangler secret put VERTEX_AI_TOKEN $(gcloud auth print-access-token)
 */

function resolveEndpoint(env) {
  const base = (env.VERTEX_AI_ENDPOINT || '').replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  return `${base}/chat/completions`;
}

async function* iterateSse(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal?.aborted) break;
      // eslint-disable-next-line no-await-in-loop
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() || '';
      // eslint-disable-next-line no-restricted-syntax
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!line) continue; // eslint-disable-line no-continue
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue; // eslint-disable-line no-continue
        try {
          yield JSON.parse(data);
        } catch {
          // ignore malformed frame
        }
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

async function* stream({
  env, model, messages, temperature, maxTokens, signal,
}) {
  if (!env.VERTEX_AI_TOKEN) {
    const err = new Error(
      'Vertex AI bearer token not configured. Refresh hourly: `wrangler secret put VERTEX_AI_TOKEN $(gcloud auth print-access-token)`',
    );
    err.status = 401;
    throw err;
  }
  if (!env.VERTEX_AI_ENDPOINT) {
    const err = new Error('Vertex AI endpoint is not configured (set VERTEX_AI_ENDPOINT).');
    err.status = 401;
    throw err;
  }

  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: true,
    stream_options: { include_usage: true },
  };

  // DiffusionGemma: fewer steps = faster generation (fewer refinement passes).
  // Model default is typically 64–128; 16–32 is a good speed/quality trade-off.
  const diffusionSteps = env.VERTEX_AI_DIFFUSION_STEPS
    ? Number(env.VERTEX_AI_DIFFUSION_STEPS)
    : null;
  if (diffusionSteps !== null && !Number.isNaN(diffusionSteps)) {
    body.num_diffusion_steps = diffusionSteps;
  }

  const response = await fetch(resolveEndpoint(env), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.VERTEX_AI_TOKEN}`,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    const hint = response.status === 401
      ? ' Token may be expired — refresh: wrangler secret put VERTEX_AI_TOKEN $(gcloud auth print-access-token)'
      : '';
    const err = new Error(`Vertex AI request failed (${response.status}): ${errorBody.slice(0, 200)}${hint}`);
    err.status = response.status;
    throw err;
  }

  let usage = null;
  const iter = iterateSse(response, signal);
  // eslint-disable-next-line no-restricted-syntax
  for await (const evt of iter) {
    const text = evt.choices?.[0]?.delta?.content;
    if (text) yield { type: 'delta', text };
    if (evt.usage) usage = evt.usage;
  }

  if (usage) {
    yield {
      type: 'usage',
      usage: {
        prompt_tokens: usage.prompt_tokens ?? null,
        completion_tokens: usage.completion_tokens ?? null,
        total_tokens: usage.total_tokens ?? null,
        cache_read_tokens: usage.cache_read_tokens ?? 0,
        cache_write_tokens: usage.cache_write_tokens ?? 0,
      },
    };
  }
}

export default { id: 'vertex', stream };
