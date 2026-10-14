/**
 * Taalas provider — official Taalas API (api.taalas.com/v1).
 *
 * Uses the /v1/completions endpoint (text completion, NOT chat completions).
 * Requires TAALAS_API_KEY for authentication.
 *
 * Key differences from other providers:
 * - Text completion format (converts messages array to single prompt)
 * - Context limit: 15k+ tokens (tested)
 * - Full recommender RAG prompt supported (~15k tokens)
 *
 * Configuration (.dev.vars):
 *   TAALAS_API_KEY      API key for authentication (required)
 *
 * Model: llama3.1-8B running on Taalas HC1 "hardcore model silicon" hardware
 */

const ENDPOINT = 'https://api.taalas.com/v1/completions';

/**
 * Convert OpenAI chat messages format to a single text prompt.
 * The Taalas API uses text completions, not chat completions.
 */
function messageRole(msg) {
  if (msg.role === 'system') return 'System';
  if (msg.role === 'assistant') return 'Assistant';
  return 'User';
}

function messagesToPrompt(messages) {
  return messages
    .map((msg) => `${messageRole(msg)}: ${msg.content}`)
    .join('\n\n');
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
  if (!env.TAALAS_API_KEY) {
    const err = new Error('Taalas API key is not configured (set TAALAS_API_KEY).');
    err.status = 401;
    throw err;
  }

  const prompt = messagesToPrompt(messages);

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.TAALAS_API_KEY}`,
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      model,
      prompt,
      max_tokens: maxTokens,
      temperature,
      stream: true,
    }),
    signal,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    const err = new Error(`Taalas API request failed (${response.status}): ${errBody.slice(0, 200)}`);
    err.status = response.status;
    throw err;
  }

  let usage = null;
  let finishReason = null;
  let contentTokens = 0;
  const iter = iterateSse(response, signal);
  // eslint-disable-next-line no-restricted-syntax
  for await (const evt of iter) {
    if (signal?.aborted) break;
    const text = evt.choices?.[0]?.text;
    if (text) {
      contentTokens += 1;
      yield { type: 'delta', text };
    }
    if (evt.choices?.[0]?.finish_reason) finishReason = evt.choices[0].finish_reason;
    if (evt.usage) usage = evt.usage;
  }

  if (usage || contentTokens || finishReason) {
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
      },
    };
  }
}

export default { id: 'taalas', stream };
