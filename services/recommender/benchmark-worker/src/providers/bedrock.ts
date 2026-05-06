import type { Message, CallResult, Provider } from './types.js';
import type { AwsCredentials } from '../auth/sigv4.js';
import { signRequest } from '../auth/sigv4.js';

// ── Bedrock event-stream parser ──────────────────────────────────────────────
//
// Bedrock streaming uses a binary framing protocol (AWS event stream).
// Each frame: [total_len 4B][header_len 4B][prelude_crc 4B][headers][payload][message_crc 4B]
// We only need to find the first non-empty payload to measure TTFT.
// For token counts we accumulate the final "metadata" event.

function readInt32BE(buf: Uint8Array, offset: number): number {
  return (
    ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>>
    0
  );
}

interface StreamEvent {
  type: 'chunk' | 'metadata' | 'other';
  text?: string;
  outputTokens?: number;
}

function parseEventStreamFrame(buf: Uint8Array): { event: StreamEvent; consumed: number } | null {
  if (buf.length < 12) return null;
  const totalLen = readInt32BE(buf, 0);
  if (buf.length < totalLen) return null;

  const headerLen = readInt32BE(buf, 4);
  const payloadStart = 12 + headerLen;
  const payloadLen = totalLen - payloadStart - 4; // 4 bytes for trailing CRC

  if (payloadLen <= 0) return { event: { type: 'other' }, consumed: totalLen };

  const payload = buf.slice(payloadStart, payloadStart + payloadLen);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return { event: { type: 'other' }, consumed: totalLen };
  }

  // Converse API response
  if (parsed.type === 'content_block_delta') {
    const delta = (parsed as { delta?: { type?: string; text?: string } }).delta;
    return { event: { type: 'chunk', text: delta?.text }, consumed: totalLen };
  }

  // InvokeModel streaming response (bytes field)
  if ('bytes' in parsed && typeof parsed.bytes === 'string') {
    try {
      const inner = JSON.parse(atob(parsed.bytes as string)) as Record<string, unknown>;
      // Anthropic Claude streaming
      if (inner.type === 'content_block_delta') {
        const delta = (inner as { delta?: { type?: string; text?: string } }).delta;
        return { event: { type: 'chunk', text: delta?.text }, consumed: totalLen };
      }
      if (inner.type === 'message_delta') {
        const usage = (inner as { usage?: { output_tokens?: number } }).usage;
        return { event: { type: 'metadata', outputTokens: usage?.output_tokens }, consumed: totalLen };
      }
      // Amazon Nova / Titan streaming
      if ('outputText' in inner) {
        return { event: { type: 'chunk', text: inner.outputText as string }, consumed: totalLen };
      }
      // Meta Llama streaming
      if ('generation' in inner) {
        return { event: { type: 'chunk', text: inner.generation as string }, consumed: totalLen };
      }
      // Mistral streaming
      if ('outputs' in inner && Array.isArray(inner.outputs)) {
        const text = (inner.outputs as Array<{ text?: string }>)[0]?.text;
        return { event: { type: 'chunk', text }, consumed: totalLen };
      }
    } catch {
      /* ignore parse errors in inner payload */
    }
  }

  return { event: { type: 'other' }, consumed: totalLen };
}

// ── Request body builders ────────────────────────────────────────────────────

function buildAnthropicBody(messages: Message[]): string {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const userMessages = messages.filter((m) => m.role !== 'system');
  return JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1024,
    system,
    messages: userMessages.map((m) => ({ role: m.role, content: m.content })),
  });
}

function buildNovaBody(messages: Message[]): string {
  const system = messages.find((m) => m.role === 'system')?.content;
  const userMessages = messages.filter((m) => m.role !== 'system');
  const body: Record<string, unknown> = {
    messages: userMessages.map((m) => ({
      role: m.role,
      content: [{ text: m.content }],
    })),
    inferenceConfig: { maxNewTokens: 1024 },
  };
  if (system) body.system = [{ text: system }];
  return JSON.stringify(body);
}

function buildLlamaBody(messages: Message[]): string {
  const systemMsg = messages.find((m) => m.role === 'system');
  const userMsg = messages.filter((m) => m.role !== 'system');
  // Llama uses a raw prompt string
  let prompt = '';
  if (systemMsg) prompt += `<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n${systemMsg.content}<|eot_id|>\n`;
  for (const m of userMsg) {
    prompt += `<|start_header_id|>${m.role}<|end_header_id|>\n${m.content}<|eot_id|>\n`;
  }
  prompt += '<|start_header_id|>assistant<|end_header_id|>\n';
  return JSON.stringify({ prompt, max_gen_len: 1024 });
}

function buildMistralBody(messages: Message[]): string {
  return JSON.stringify({
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    max_tokens: 1024,
  });
}

// ── Core call ────────────────────────────────────────────────────────────────

async function callBedrock(
  modelId: string,
  region: string,
  credentials: AwsCredentials,
  messages: Message[],
  bodyBuilder: (messages: Message[]) => string,
): Promise<CallResult> {
  const start = Date.now();
  let ttftMs = 0;
  let outputTokens = 0;

  const body = bodyBuilder(messages);
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/invoke-with-response-stream`;

  const req = await signRequest(
    new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/vnd.amazon.eventstream' },
      body,
    }),
    credentials,
    'bedrock',
    region,
  );

  let response: Response;
  try {
    response = await fetch(req);
  } catch (err) {
    return { ttftMs: 0, totalMs: Date.now() - start, outputTokens: 0, error: String(err) };
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return {
      ttftMs: 0,
      totalMs: Date.now() - start,
      outputTokens: 0,
      error: `HTTP ${response.status}: ${text.slice(0, 200)}`,
    };
  }

  if (!response.body) {
    return { ttftMs: 0, totalMs: Date.now() - start, outputTokens: 0, error: 'No response body' };
  }

  const reader = response.body.getReader();
  let accumulated = new Uint8Array(0);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Append new bytes to buffer
      const next = new Uint8Array(accumulated.length + value.length);
      next.set(accumulated);
      next.set(value, accumulated.length);
      accumulated = next;

      // Drain complete frames
      while (accumulated.length >= 12) {
        const result = parseEventStreamFrame(accumulated);
        if (!result) break;

        const { event, consumed } = result;
        accumulated = accumulated.slice(consumed);

        if (event.type === 'chunk' && event.text && ttftMs === 0) {
          ttftMs = Date.now() - start;
        }
        if (event.type === 'metadata' && event.outputTokens) {
          outputTokens = event.outputTokens;
        }
      }
    }
  } catch (err) {
    return { ttftMs, totalMs: Date.now() - start, outputTokens, error: String(err) };
  }

  return { ttftMs: ttftMs || Date.now() - start, totalMs: Date.now() - start, outputTokens };
}

// ── Provider factory ─────────────────────────────────────────────────────────

const BEDROCK_MODELS: Array<{
  id: string;
  label: string;
  builder: (messages: Message[]) => string;
}> = [
  {
    id: 'us.anthropic.claude-3-5-haiku-20241022-v1:0',
    label: 'bedrock/claude-3-5-haiku',
    builder: buildAnthropicBody,
  },
  { id: 'amazon.nova-micro-v1:0', label: 'bedrock/nova-micro', builder: buildNovaBody },
  { id: 'amazon.nova-lite-v1:0', label: 'bedrock/nova-lite', builder: buildNovaBody },
  { id: 'amazon.nova-pro-v1:0', label: 'bedrock/nova-pro', builder: buildNovaBody },
  {
    id: 'us.meta.llama4-scout-17b-instruct-v1:0',
    label: 'bedrock/llama-4-scout',
    builder: buildLlamaBody,
  },
  {
    id: 'us.meta.llama3-3-70b-instruct-v1:0',
    label: 'bedrock/llama-3.3-70b',
    builder: buildLlamaBody,
  },
  {
    id: 'mistral.mistral-large-2402-v1:0',
    label: 'bedrock/mistral-large',
    builder: buildMistralBody,
  },
];

export function makeBedrockProviders(
  region: string,
  accessKeyId: string,
  secretAccessKey: string,
): Provider[] {
  const credentials: AwsCredentials = { accessKeyId, secretAccessKey };
  return BEDROCK_MODELS.map(({ id, label, builder }) => ({
    label,
    call: (messages: Message[]) => callBedrock(id, region, credentials, messages, builder),
  }));
}
