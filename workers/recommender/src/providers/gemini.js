/**
 * Vertex Gemini publisher API. ADC is supplied by the Cloud Run runtime so this
 * provider remains importable by Workers without bringing in a Node auth SDK.
 */
async function accessToken(env) {
  const result = env.GCP_ACCESS_TOKEN
    ? await env.GCP_ACCESS_TOKEN()
    : await env.GCP_AUTH?.getAccessToken();
  const token = typeof result === 'string' ? result : result?.token;
  if (!token) {
    const error = new Error('Vertex Gemini ADC is not configured.');
    error.status = 401;
    throw error;
  }
  return token;
}

async function* stream({
  env, model, messages, temperature, maxTokens, thinking, signal,
}) {
  const project = env.GOOGLE_CLOUD_PROJECT || 'api-project-642841493686';
  const location = env.VERTEX_LOCATION || 'us-central1';
  const token = await accessToken(env);
  const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/google/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const system = messages.filter((m) => m.role === 'system').map((m) => ({ text: String(m.content) }));
  const body = {
    contents: messages.filter((m) => m.role !== 'system').map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content) }],
    })),
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  };
  if (thinking === false && model.startsWith('gemini-2.5-flash')) {
    body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  if (system.length) body.systemInstruction = { parts: system };
  const response = await (env.GCP_FETCH || fetch)(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal || AbortSignal.timeout(180_000),
  });
  if (!response.ok) {
    const error = new Error(`Vertex Gemini request failed (HTTP ${response.status}).`);
    error.status = response.status;
    throw error;
  }
  if (!response.body) throw new Error('Vertex Gemini response has no stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let usage;
  let finishReason;
  let emitted = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer = (buffer + decoder.decode(value, { stream: !done })).replace(/\r\n/g, '\n');
      // Process complete SSE records, including a final record lacking a blank line.
      if (done && buffer.trim()) buffer += '\n\n';
      while (buffer.includes('\n\n')) {
        const boundary = buffer.indexOf('\n\n');
        const record = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = record.split('\n').filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        const event = JSON.parse(data);
        if (event.error) {
          const error = new Error(`Vertex Gemini stream failed (${event.error.status || 'unknown'}).`);
          error.status = event.error.code;
          throw error;
        }
        const candidate = event.candidates?.[0];
        finishReason = candidate?.finishReason || finishReason;
        for (const part of candidate?.content?.parts || []) {
          if (part.text && !part.thought) {
            emitted = true;
            yield { type: 'delta', text: part.text };
          }
        }
        if (event.promptFeedback?.blockReason) throw new Error('Vertex Gemini blocked the prompt.');
        if (event.usageMetadata) {
          const u = event.usageMetadata;
          usage = {
            prompt_tokens: u.promptTokenCount || 0,
            completion_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0),
            total_tokens: u.totalTokenCount || 0,
            cache_read_tokens: u.cachedContentTokenCount || 0,
            cache_write_tokens: 0,
          };
        }
      }
      if (done) break;
    }
    if (!emitted) throw new Error(`Vertex Gemini returned no text (${finishReason || 'empty response'}).`);
    if (finishReason && !['STOP', 'MAX_TOKENS'].includes(finishReason)) {
      throw new Error(`Vertex Gemini stopped generation (${finishReason}).`);
    }
    if (usage) yield { type: 'usage', usage };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export default { id: 'gemini', stream };
