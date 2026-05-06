import type { Message, CallResult, Provider } from './types.js';
import { callOpenAICompat } from './openai-compat.js';

// ── Gemini native streaming ──────────────────────────────────────────────────

interface GeminiChunk {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  usageMetadata?: { candidatesTokenCount?: number };
}

async function callGemini(
  projectId: string,
  location: string,
  model: string,
  accessToken: string,
  messages: Message[],
): Promise<CallResult> {
  const start = Date.now();
  let ttftMs = 0;
  let outputTokens = 0;

  // Convert OpenAI-style messages to Gemini format
  const systemParts = messages
    .filter((m) => m.role === 'system')
    .map((m) => ({ text: m.content }));
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

  const body: Record<string, unknown> = { contents };
  if (systemParts.length > 0) {
    body.systemInstruction = { parts: systemParts };
  }
  body.generationConfig = { maxOutputTokens: 1024 };

  const url =
    `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}` +
    `/locations/${location}/publishers/google/models/${model}:streamGenerateContent?alt=sse`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
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

        let chunk: GeminiChunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }

        const text = chunk.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text && ttftMs === 0) {
          ttftMs = Date.now() - start;
        }

        if (chunk.usageMetadata?.candidatesTokenCount) {
          outputTokens = chunk.usageMetadata.candidatesTokenCount;
        }
      }
    }
  } catch (err) {
    return { ttftMs, totalMs: Date.now() - start, outputTokens, error: String(err) };
  }

  return { ttftMs: ttftMs || Date.now() - start, totalMs: Date.now() - start, outputTokens };
}

// ── Provider factory ─────────────────────────────────────────────────────────

const GEMINI_MODELS = [
  { id: 'gemini-2.5-flash-lite', label: 'gemini-2.5-flash-lite (production)' },
  { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
  { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
  { id: 'gemini-2.0-flash', label: 'gemini-2.0-flash' },
  { id: 'gemini-3-flash-preview', label: 'gemini-3-flash-preview' },
  { id: 'gemini-3.1-flash-lite-preview', label: 'gemini-3.1-flash-lite-preview' },
  { id: 'gemini-3.1-pro-preview', label: 'gemini-3.1-pro-preview' },
];

// Llama MaaS is OpenAI-compatible, hosted on us-east5
const LLAMA_MAAS_MODELS = [
  {
    id: 'meta/llama-4-maverick-17b-128e-instruct-maas',
    label: 'vertex/llama-4-maverick',
  },
  {
    id: 'meta/llama-4-scout-17b-16e-instruct-maas',
    label: 'vertex/llama-4-scout',
  },
  { id: 'llama-3.3-70b-instruct-maas', label: 'vertex/llama-3.3-70b' },
  { id: 'llama-3.1-70b-instruct-maas', label: 'vertex/llama-3.1-70b' },
];

// Gemma and Mistral are served via Vertex AI Model Garden (native Gemini API)
const MODEL_GARDEN_MODELS = [
  { id: 'gemma-3-27b-it', label: 'vertex/gemma-3-27b' },
  { id: 'gemma-3-12b-it', label: 'vertex/gemma-3-12b' },
  { id: 'mistral-medium-3', label: 'vertex/mistral-medium-3' },
  { id: 'mistral-small-2503', label: 'vertex/mistral-small-3.1' },
];

export function makeVertexProviders(
  projectId: string,
  location: string,
  accessToken: string,
): Provider[] {
  const geminiProviders: Provider[] = GEMINI_MODELS.map(({ id, label }) => ({
    label,
    call: (messages: Message[]) => callGemini(projectId, location, id, accessToken, messages),
  }));

  const modelGardenProviders: Provider[] = MODEL_GARDEN_MODELS.map(({ id, label }) => ({
    label,
    call: (messages: Message[]) => callGemini(projectId, location, id, accessToken, messages),
  }));

  // Llama MaaS on us-east5 uses the OpenAI-compatible endpoint
  const llamaMaasBase = `https://us-east5-aiplatform.googleapis.com/v1beta1/projects/${projectId}/locations/us-east5/endpoints/openapi`;
  const llamaProviders: Provider[] = LLAMA_MAAS_MODELS.map(({ id, label }) => ({
    label,
    call: (messages: Message[]) =>
      callOpenAICompat(llamaMaasBase, accessToken, id, messages),
  }));

  return [...geminiProviders, ...llamaProviders, ...modelGardenProviders];
}
