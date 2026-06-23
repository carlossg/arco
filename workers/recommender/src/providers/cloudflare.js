/**
 * Cloudflare Workers AI provider — two transports, same normalized contract:
 *
 *  1. Binding (`env.AI.run`) — used in production / whenever the AI binding is
 *     usable. Returns a ReadableStream of SSE frames.
 *  2. REST (`https://api.cloudflare.com/.../ai/run/{model}`) — used when a token
 *     is configured (env.CF_ACCOUNT_ID + CLOUDFLARE_API_TOKEN/CF_AI_TOKEN).
 *     This bypasses the remote-binding proxy, so Cloudflare models work under
 *     `wrangler dev --local` (where the AI binding errors "needs to be run
 *     remotely"). Only needs the Workers AI: Read+Edit token scope.
 *
 * Both yield { type:'delta', text } chunks and a terminal { type:'usage', usage }.
 * Reasoning ("thinking") deltas are counted but not streamed into the page.
 */

function getRestConfig(env) {
  const token = env.CF_AI_TOKEN || env.CLOUDFLARE_API_TOKEN;
  const account = env.CF_ACCOUNT_ID;
  return token && account ? { token, account } : null;
}

/**
 * Whether to disable the thinking phase. Driven by the per-request `thinking`
 * config (true/false/null from Model Settings); null falls back to the CF_THINK
 * env default.
 */
function thinkingDisabled(env, thinking) {
  if (thinking === false) return true;
  if (thinking === true) return false;
  return String(env.CF_THINK).toLowerCase() === 'false';
}

/**
 * Extra run inputs. Reasoning-capable models (e.g. Nemotron) support
 * chat_template_kwargs.enable_thinking. Opt-in only — some non-reasoning models
 * reject/misbehave on this kwarg, so we only send it when thinking is disabled.
 */
function reasoningOpts(disabled) {
  return disabled ? { chat_template_kwargs: { enable_thinking: false } } : {};
}

/** Split an SSE byte stream into parsed `data:` JSON objects. */
async function* iterateSse(readable, signal) {
  const reader = readable.getReader();
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

/**
 * Consume a Workers AI SSE stream (same frame shape from binding or REST) and
 * yield normalized deltas + a terminal usage frame.
 */
async function* consume(readable, signal, treatReasoningAsContent = false) {
  let usage = null;
  let thinkingTokens = 0;
  let contentTokens = 0;
  let finishReason = null;
  // eslint-disable-next-line no-restricted-syntax
  for await (const evt of iterateSse(readable, signal)) {
    if (signal?.aborted) break;
    const delta = evt.choices?.[0]?.delta;
    // `response` is the legacy binding shape; `choices[].delta.content` is the
    // OpenAI shape used by REST and newer models.
    const text = typeof evt.response === 'string' ? evt.response : delta?.content;
    // When thinking is disabled, CF streams the answer under `reasoning` (a
    // streaming quirk — non-stream puts it in `content`). Route it to content.
    if (delta?.reasoning) {
      if (treatReasoningAsContent) {
        contentTokens += 1;
        yield { type: 'delta', text: delta.reasoning };
      } else {
        thinkingTokens += 1;
      }
    }
    if (text) {
      contentTokens += 1;
      yield { type: 'delta', text };
    }
    if (evt.choices?.[0]?.finish_reason) finishReason = evt.choices[0].finish_reason;
    if (evt.usage) usage = evt.usage;
  }
  if (usage || contentTokens || thinkingTokens) {
    const u = usage || {};
    const prompt = u.prompt_tokens ?? u.input_tokens ?? null;
    const completion = u.completion_tokens ?? u.output_tokens ?? null;
    yield {
      type: 'usage',
      usage: {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: u.total_tokens ?? (((prompt ?? 0) + (completion ?? 0)) || null),
        cache_read_tokens: u.prompt_tokens_details?.cached_tokens || 0,
        cache_write_tokens: 0,
        done_reason: finishReason,
        thinking_tokens: thinkingTokens,
        content_tokens: contentTokens,
      },
    };
  }
}

async function* streamViaRest({
  env, model, messages, temperature, maxTokens, thinking, signal,
}) {
  const rest = getRestConfig(env);
  const disabled = thinkingDisabled(env, thinking);
  const url = `https://api.cloudflare.com/client/v4/accounts/${rest.account}/ai/run/${model}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${rest.token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      messages, stream: true, max_tokens: maxTokens, temperature, ...reasoningOpts(disabled),
    }),
    signal,
  });
  if (!response.ok || !response.body) {
    const body = await response.text().catch(() => '');
    const err = new Error(`Cloudflare AI REST failed (${response.status}): ${body.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }
  yield* consume(response.body, signal, disabled);
}

async function* streamViaBinding({
  env, model, messages, temperature, maxTokens, thinking, signal,
}) {
  const disabled = thinkingDisabled(env, thinking);
  const result = await env.AI.run(model, {
    messages, stream: true, max_tokens: maxTokens, temperature, ...reasoningOpts(disabled),
  });
  const readable = result instanceof ReadableStream ? result : result?.readable;
  if (!readable) throw new Error('Cloudflare AI did not return a stream.');
  yield* consume(readable, signal, disabled);
}

async function* stream(opts) {
  const { env } = opts;
  // Prefer REST when a token is configured (works under --local); otherwise the
  // binding. This lets local dev reach Workers AI without the remote-binding proxy.
  if (getRestConfig(env)) {
    yield* streamViaRest(opts);
    return;
  }
  if (!env.AI) {
    const err = new Error('Cloudflare AI is not configured (need the AI binding or CF_ACCOUNT_ID + CLOUDFLARE_API_TOKEN).');
    err.status = 500;
    throw err;
  }
  yield* streamViaBinding(opts);
}

export default { id: 'cloudflare', stream };
