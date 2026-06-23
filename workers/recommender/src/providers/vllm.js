/**
 * vLLM provider — OpenAI-compatible /v1/chat/completions over HTTP.
 *
 * vLLM serves an OpenAI-compatible API, so this mirrors the SambaNova provider.
 * Point at VLLM_BASE_URL (e.g. http://localhost:8000/v1, or an SSH-forwarded
 * remote vLLM). VLLM_API_KEY is optional — only needed if the server was started
 * with --api-key.
 *
 * Reasoning models (vLLM started with a reasoning parser, e.g. --reasoning-parser)
 * stream `delta.reasoning_content` separately from `delta.content`; we count the
 * split and, when thinking is disabled, send chat_template_kwargs.enable_thinking
 * = false. The per-request `thinking` config (Model Settings) wins; VLLM_THINK is
 * the env fallback default.
 *
 * No per-request decode timing is returned (tok/s is wall-clock, computed in
 * llm-generate). Richer aggregate metrics — TTFT, throughput — live on vLLM's
 * Prometheus /metrics endpoint, not in the generation response.
 */

function resolveEndpoint(env) {
  const base = (env.VLLM_BASE_URL || '').replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  if (base.endsWith('/v1')) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

function thinkingDisabled(env, thinking) {
  if (thinking === false) return true;
  if (thinking === true) return false;
  return String(env.VLLM_THINK).toLowerCase() === 'false';
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
  env, model, messages, temperature, maxTokens, thinking, signal,
}) {
  if (!env.VLLM_BASE_URL) {
    const err = new Error('vLLM base URL is not configured (set VLLM_BASE_URL).');
    err.status = 401;
    throw err;
  }

  const disabled = thinkingDisabled(env, thinking);
  const body = {
    model,
    messages,
    max_tokens: maxTokens,
    temperature,
    stream: true,
    stream_options: { include_usage: true },
    // Only sent when explicitly disabling — reasoning-capable models honor it via
    // their chat template; non-reasoning models ignore it.
    ...(disabled ? { chat_template_kwargs: { enable_thinking: false } } : {}),
  };

  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  };
  if (env.VLLM_API_KEY) headers.Authorization = `Bearer ${env.VLLM_API_KEY}`;

  const response = await fetch(resolveEndpoint(env), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    const err = new Error(`vLLM request failed (${response.status}): ${errBody.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  let usage = null;
  let thinkingTokens = 0;
  let contentTokens = 0;
  let finishReason = null;
  const iter = iterateSse(response, signal);
  // eslint-disable-next-line no-restricted-syntax
  for await (const evt of iter) {
    if (signal?.aborted) break;
    const delta = evt.choices?.[0]?.delta;
    // Reasoning models expose a separate reasoning_content stream — count it as
    // thinking, don't put it in the page.
    if (delta?.reasoning_content) thinkingTokens += 1;
    const text = delta?.content;
    if (text) {
      contentTokens += 1;
      yield { type: 'delta', text };
    }
    if (evt.choices?.[0]?.finish_reason) finishReason = evt.choices[0].finish_reason;
    if (evt.usage) usage = evt.usage;
  }

  if (usage || contentTokens || thinkingTokens) {
    const u = usage || {};
    yield {
      type: 'usage',
      usage: {
        prompt_tokens: u.prompt_tokens ?? null,
        completion_tokens: u.completion_tokens ?? null,
        total_tokens: u.total_tokens ?? null,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        done_reason: finishReason,
        thinking_tokens: thinkingTokens,
        content_tokens: contentTokens,
      },
    };
  }
}

export default { id: 'vllm', stream };
