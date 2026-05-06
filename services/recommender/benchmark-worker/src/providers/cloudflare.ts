import type { Message, CallResult, Provider } from './types.js';
import { callOpenAICompat } from './openai-compat.js';

const CF_MODELS = [
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct', label: 'cloudflare/llama-4-scout-17b' },
  { id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', label: 'cloudflare/llama-3.3-70b' },
  { id: '@cf/mistralai/mistral-small-3.1-24b-instruct', label: 'cloudflare/mistral-small-3.1' },
  { id: '@cf/qwen/qwq-32b', label: 'cloudflare/qwq-32b' },
  { id: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', label: 'cloudflare/deepseek-r1-distill' },
  { id: '@cf/google/gemma-3-12b-it', label: 'cloudflare/gemma-3-12b' },
];

export function makeCloudflareProviders(accountId: string, apiToken: string): Provider[] {
  const baseUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;

  return CF_MODELS.map(({ id, label }) => ({
    label,
    call(messages: Message[]): Promise<CallResult> {
      return callOpenAICompat(baseUrl, apiToken, id, messages);
    },
  }));
}
