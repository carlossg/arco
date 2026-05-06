import type { Message, CallResult } from './types.js';

interface ChatChunk {
  choices?: Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  usage?: {
    completion_tokens?: number;
    output_tokens?: number;
  };
}

/**
 * Calls an OpenAI-compatible /chat/completions endpoint with streaming.
 * Returns TTFT (time to first token) and total latency.
 */
export async function callOpenAICompat(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: Message[],
  extraHeaders?: Record<string, string>,
): Promise<CallResult> {
  const start = Date.now();
  let ttftMs = 0;
  let outputTokens = 0;

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...extraHeaders,
      },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: 1024,
      }),
    });
  } catch (err) {
    return { ttftMs: 0, totalMs: Date.now() - start, outputTokens: 0, error: String(err) };
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    return {
      ttftMs: 0,
      totalMs: Date.now() - start,
      outputTokens: 0,
      error: `HTTP ${response.status}: ${body.slice(0, 200)}`,
    };
  }

  if (!response.body) {
    return { ttftMs: 0, totalMs: Date.now() - start, outputTokens: 0, error: 'No response body' };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;

        let chunk: ChatChunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        const content = chunk.choices?.[0]?.delta?.content;
        if (content && ttftMs === 0) {
          ttftMs = Date.now() - start;
        }

        // Some providers send usage in the final chunk
        if (chunk.usage?.completion_tokens) {
          outputTokens = chunk.usage.completion_tokens;
        } else if (chunk.usage?.output_tokens) {
          outputTokens = chunk.usage.output_tokens;
        }
      }
    }
  } catch (err) {
    return { ttftMs, totalMs: Date.now() - start, outputTokens, error: String(err) };
  }

  return { ttftMs: ttftMs || Date.now() - start, totalMs: Date.now() - start, outputTokens };
}
