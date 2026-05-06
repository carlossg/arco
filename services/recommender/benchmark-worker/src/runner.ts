import { makeCloudflareProviders } from './providers/cloudflare.js';
import { makeCerebrasProviders } from './providers/cerebras.js';
import { makeVertexProviders } from './providers/vertex.js';
import { makeBedrockProviders } from './providers/bedrock.js';
import { getVertexAccessToken } from './auth/vertex-jwt.js';
import { TEST_QUERIES, classificationMessages, reasoningMessages } from './prompts.js';
import { computeStats } from './providers/types.js';
import type { Provider, CallResult, ProviderStats } from './providers/types.js';

export interface BenchmarkResult {
  runId: string;
  startedAt: string;
  durationMs: number;
  classification: ProviderStats[];
  reasoning: ProviderStats[];
}

export interface Env {
  RESULTS_KV: KVNamespace;
  RESULTS_R2: R2Bucket;
  CLOUDFLARE_ACCOUNT_ID: string;
  CLOUDFLARE_API_TOKEN: string;
  GCP_PROJECT_ID: string;
  GCP_LOCATION: string;
  GCP_SERVICE_ACCOUNT_JSON: string;
  CEREBRAS_API_KEY: string;
  AWS_REGION: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
}

/** Run all 15 test queries through a single provider sequentially. */
async function runProvider(
  provider: Provider,
  promptType: 'classification' | 'reasoning',
): Promise<CallResult[]> {
  const results: CallResult[] = [];
  for (const { query, comparisonHint } of TEST_QUERIES) {
    const messages =
      promptType === 'classification'
        ? classificationMessages(query)
        : reasoningMessages(query, comparisonHint);
    results.push(await provider.call(messages));
  }
  return results;
}

/** Run all providers for one prompt type concurrently. */
async function runAllProviders(
  providers: Provider[],
  promptType: 'classification' | 'reasoning',
): Promise<ProviderStats[]> {
  const results = await Promise.allSettled(
    providers.map((p) => runProvider(p, promptType)),
  );

  return results.map((result, i) => {
    const provider = providers[i];
    if (result.status === 'rejected') {
      return computeStats(provider.label, [
        {
          ttftMs: 0,
          totalMs: 0,
          outputTokens: 0,
          error: String(result.reason),
        },
      ]);
    }
    return computeStats(provider.label, result.value);
  });
}

export async function runBenchmarks(env: Env): Promise<BenchmarkResult> {
  const startedAt = new Date().toISOString();
  const wallStart = Date.now();

  // Auth phase — get Vertex token once, reuse across all Vertex providers
  let vertexToken = '';
  try {
    vertexToken = await getVertexAccessToken(env.GCP_SERVICE_ACCOUNT_JSON);
  } catch (err) {
    console.error('Vertex auth failed:', err);
  }

  // Build all providers
  const providers: Provider[] = [
    ...makeCloudflareProviders(env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_API_TOKEN),
    ...makeCerebrasProviders(env.CEREBRAS_API_KEY),
    ...(vertexToken
      ? makeVertexProviders(env.GCP_PROJECT_ID, env.GCP_LOCATION, vertexToken)
      : []),
    ...makeBedrockProviders(env.AWS_REGION, env.AWS_ACCESS_KEY_ID, env.AWS_SECRET_ACCESS_KEY),
  ];

  // Run classification and reasoning benchmarks concurrently
  const [classification, reasoning] = await Promise.all([
    runAllProviders(providers, 'classification'),
    runAllProviders(providers, 'reasoning'),
  ]);

  const result: BenchmarkResult = {
    runId: `run-${startedAt.replace(/[:.]/g, '-')}`,
    startedAt,
    durationMs: Date.now() - wallStart,
    classification,
    reasoning,
  };

  // Persist to KV (fast reads) and R2 (archive)
  const json = JSON.stringify(result, null, 2);
  await env.RESULTS_KV.put('latest', json);
  await env.RESULTS_R2.put(`${result.runId}.json`, json, {
    httpMetadata: { contentType: 'application/json' },
  });

  return result;
}
