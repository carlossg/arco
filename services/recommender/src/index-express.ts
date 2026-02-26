/**
 * Arco Recommender - Cloud Run Service (Google-Native)
 *
 * Express HTTP server that powers AI-driven Arco coffee equipment recommendations.
 * Uses Gemini + Vertex AI Model Garden with passwordless authentication.
 *
 * Endpoints:
 * - GET /generate?query=...&slug=...&ctx=... - Stream page generation via SSE
 * - POST /api/persist - Persist generated pages to AEM DA
 * - GET /api/presets - List all model presets with role assignments
 * - GET /api/benchmark?query=...&presets=... - Benchmark classification + reasoning
 * - GET /api/benchmark-full?query=...&presets=... - Full pipeline benchmark
 * - GET /health - Health check
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import type { SessionContext, SSEEvent, IntentClassification } from './types';
import { orchestrate } from './lib/orchestrator';
import { persistAndPublish, buildPageHtml, unescapeHtml } from './lib/da-client';
import { classifyCategory, generateSemanticSlug, buildCategorizedPath } from './lib/category-classifier';
import { GoogleModelFactory } from './ai-clients/model-factory-google';

// ============================================
// Configuration
// ============================================

const PORT = parseInt(process.env.PORT || '8080', 10);
const NODE_ENV = process.env.NODE_ENV || 'development';

// DA (Document Authoring) env for persist operations
const daEnv = {
  DA_ORG: process.env.DA_ORG || '',
  DA_REPO: process.env.DA_REPO || '',
  DA_TOKEN: process.env.DA_TOKEN || process.env.TOKEN || '',
  DA_CLIENT_ID: process.env.DA_CLIENT_ID,
  DA_CLIENT_SECRET: process.env.DA_CLIENT_SECRET,
  DA_SERVICE_TOKEN: process.env.DA_SERVICE_TOKEN,
};

// ============================================
// Express App Setup
// ============================================

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Disable X-Powered-By header for security
app.disable('x-powered-by');

// ============================================
// SSE Helper
// ============================================

function sendSSE(res: Response, event: SSEEvent): void {
  res.write(`event: ${event.event}\n`);
  res.write(`data: ${JSON.stringify(event.data)}\n\n`);
}

// ============================================
// GET /generate - Stream page generation via SSE
// ============================================

app.get('/generate', async (req: Request, res: Response) => {
  const query = req.query.query as string;
  const slug = req.query.slug as string | undefined;
  const ctxParam = req.query.ctx as string | undefined;
  const preset = req.query.preset as string | undefined;

  if (!query) {
    res.status(400).json({ error: 'Missing required parameter: query' });
    return;
  }

  // Parse session context if provided
  let sessionContext: SessionContext | undefined;
  if (ctxParam) {
    try {
      sessionContext = JSON.parse(decodeURIComponent(ctxParam));
    } catch {
      console.warn('[generate] Failed to parse ctx parameter, ignoring');
    }
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const startTime = Date.now();

  try {
    // Create model factory with optional preset override
    const modelFactory = new GoogleModelFactory(
      preset || process.env.MODEL_PRESET || 'production',
    );

    // Send generation-start event
    sendSSE(res, {
      event: 'generation-start',
      data: { query, estimatedBlocks: 4 },
    });

    // Track blocks for persist
    const generatedBlocks: Array<{ html: string; sectionStyle?: string }> = [];
    let finalIntent: IntentClassification | undefined;

    // Run orchestration with SSE streaming
    await orchestrate(
      query,
      slug || '',
      daEnv,
      (event: SSEEvent) => {
        sendSSE(res, event);

        // Capture blocks for later persist
        if (event.event === 'block-content') {
          generatedBlocks.push({
            html: event.data.html,
            sectionStyle: event.data.sectionStyle,
          });
        }

        // Capture intent from generation-complete
        if (event.event === 'generation-complete' && event.data.intent) {
          finalIntent = event.data.intent;
        }
      },
      sessionContext,
      preset || undefined,
    );

    // Determine the page path
    let pagePath: string;
    if (slug) {
      pagePath = slug.startsWith('/') ? slug : `/${slug}`;
    } else if (finalIntent) {
      const category = classifyCategory(finalIntent, query);
      const semanticSlug = generateSemanticSlug(query, finalIntent);
      pagePath = buildCategorizedPath(category, semanticSlug);
    } else {
      // Fallback: simple slug from query
      const fallbackSlug = query
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 60);
      pagePath = `/discover/${fallbackSlug}`;
    }

    // Send complete event with path info
    sendSSE(res, {
      event: 'complete',
      data: {
        message: 'Generation complete',
        path: pagePath,
        duration: Date.now() - startTime,
        blocks: generatedBlocks.length,
      } as any,
    });

    res.end();
  } catch (error) {
    console.error('[generate] Error:', error);
    sendSSE(res, {
      event: 'error',
      data: {
        message: error instanceof Error ? error.message : 'Unknown error',
        code: 'GENERATION_FAILED',
      },
    });
    res.end();
  }
});

// ============================================
// POST /api/persist - Persist generated pages to AEM DA
// ============================================

app.post('/api/persist', async (req: Request, res: Response) => {
  const { path, blocks, title, description, query, intent } = req.body;

  if (!path || !blocks || !Array.isArray(blocks)) {
    res.status(400).json({
      error: 'Missing required fields: path, blocks (array)',
    });
    return;
  }

  try {
    // Build page title and description
    const pageTitle = title || unescapeHtml(query || 'Your Arco Coffee Experience');
    const pageDescription = description || `Personalized Arco coffee equipment content for: ${query || 'your needs'}`;

    // Build full HTML page
    const html = buildPageHtml(pageTitle, pageDescription, blocks);

    console.log(`[persist] Persisting page to: ${path}`);
    console.log(`[persist] Title: ${pageTitle}`);
    console.log(`[persist] Blocks: ${blocks.length}`);
    console.log(`[persist] HTML size: ${html.length} bytes`);

    // Persist to DA and publish
    const result = await persistAndPublish(path, html, daEnv as any);

    if (result.success) {
      console.log(`[persist] Success! Preview: ${result.urls?.preview}`);
      res.json({
        success: true,
        path,
        urls: result.urls,
        title: pageTitle,
        blocks: blocks.length,
      });
    } else {
      console.error(`[persist] Failed: ${result.error}`);
      res.status(500).json({
        success: false,
        error: result.error,
      });
    }
  } catch (error) {
    console.error('[persist] Error:', error);
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

// ============================================
// GET /api/presets - List all model presets
// ============================================

interface PresetInfo {
  name: string;
  category: 'pure' | 'mixed' | 'model-garden' | 'gemma' | 'production';
  description: string;
  roles: Record<string, { provider: string; model: string; maxTokens?: number; temperature?: number }>;
  requiresEndpoint: boolean;
}

function getPresetList(): PresetInfo[] {
  const presets: PresetInfo[] = [
    // Pure presets
    {
      name: 'gemini-3-pro',
      category: 'pure',
      description: 'Gemini 3 Pro for all roles — highest quality, slower',
      roles: {
        reasoning:      { provider: 'google', model: 'gemini-3-pro-preview', maxTokens: 2048, temperature: 0.7 },
        content:        { provider: 'google', model: 'gemini-3-pro-preview', maxTokens: 1536, temperature: 0.8 },
        classification: { provider: 'google', model: 'gemini-3-pro-preview', maxTokens: 512, temperature: 0.3 },
        validation:     { provider: 'google', model: 'gemini-3-pro-preview', maxTokens: 256, temperature: 0.2 },
      },
      requiresEndpoint: false,
    },
    {
      name: 'gemini-3-flash',
      category: 'pure',
      description: 'Gemini 3 Flash for all roles — fast, good quality',
      roles: {
        reasoning:      { provider: 'google', model: 'gemini-3-flash-preview', maxTokens: 2048, temperature: 0.7 },
        content:        { provider: 'google', model: 'gemini-3-flash-preview', maxTokens: 1536, temperature: 0.8 },
        classification: { provider: 'google', model: 'gemini-3-flash-preview', maxTokens: 512, temperature: 0.3 },
        validation:     { provider: 'google', model: 'gemini-3-flash-preview', maxTokens: 256, temperature: 0.2 },
      },
      requiresEndpoint: false,
    },
    {
      name: 'gemini-2.5-pro',
      category: 'pure',
      description: 'Gemini 2.5 Pro for all roles — strong reasoning, moderate speed',
      roles: {
        reasoning:      { provider: 'google', model: 'gemini-2.5-pro', maxTokens: 2048, temperature: 0.7 },
        content:        { provider: 'google', model: 'gemini-2.5-pro', maxTokens: 1536, temperature: 0.8 },
        classification: { provider: 'google', model: 'gemini-2.5-pro', maxTokens: 512, temperature: 0.3 },
        validation:     { provider: 'google', model: 'gemini-2.5-pro', maxTokens: 256, temperature: 0.2 },
      },
      requiresEndpoint: false,
    },
    {
      name: 'gemini-2.5-flash',
      category: 'pure',
      description: 'Gemini 2.5 Flash for all roles — balanced speed/quality',
      roles: {
        reasoning:      { provider: 'google', model: 'gemini-2.5-flash', maxTokens: 2048, temperature: 0.7 },
        content:        { provider: 'google', model: 'gemini-2.5-flash', maxTokens: 1536, temperature: 0.8 },
        classification: { provider: 'google', model: 'gemini-2.5-flash', maxTokens: 512, temperature: 0.3 },
        validation:     { provider: 'google', model: 'gemini-2.5-flash', maxTokens: 256, temperature: 0.2 },
      },
      requiresEndpoint: false,
    },
    {
      name: 'gemini-2.5-flash-lite',
      category: 'pure',
      description: 'Gemini 2.5 Flash Lite for all roles — optimized for low latency, 1M context',
      roles: {
        reasoning:      { provider: 'google', model: 'gemini-2.5-flash-lite', maxTokens: 2048, temperature: 0.7 },
        content:        { provider: 'google', model: 'gemini-2.5-flash-lite', maxTokens: 1536, temperature: 0.8 },
        classification: { provider: 'google', model: 'gemini-2.5-flash-lite', maxTokens: 512, temperature: 0.3 },
        validation:     { provider: 'google', model: 'gemini-2.5-flash-lite', maxTokens: 256, temperature: 0.2 },
      },
      requiresEndpoint: false,
    },
    {
      name: 'gemini-2.0-flash',
      category: 'pure',
      description: 'Gemini 2.0 Flash for all roles — fastest Gemini, cost-effective',
      roles: {
        reasoning:      { provider: 'google', model: 'gemini-2.0-flash', maxTokens: 2048, temperature: 0.7 },
        content:        { provider: 'google', model: 'gemini-2.0-flash', maxTokens: 1536, temperature: 0.8 },
        classification: { provider: 'google', model: 'gemini-2.0-flash', maxTokens: 512, temperature: 0.3 },
        validation:     { provider: 'google', model: 'gemini-2.0-flash', maxTokens: 256, temperature: 0.2 },
      },
      requiresEndpoint: false,
    },
    {
      name: 'gemini-2.0-flash-lite',
      category: 'pure',
      description: 'Gemini 2.0 Flash Lite for all roles — ultra-fast, lowest cost',
      roles: {
        reasoning:      { provider: 'google', model: 'gemini-2.0-flash-lite', maxTokens: 2048, temperature: 0.7 },
        content:        { provider: 'google', model: 'gemini-2.0-flash-lite', maxTokens: 1536, temperature: 0.8 },
        classification: { provider: 'google', model: 'gemini-2.0-flash-lite', maxTokens: 512, temperature: 0.3 },
        validation:     { provider: 'google', model: 'gemini-2.0-flash-lite', maxTokens: 256, temperature: 0.2 },
      },
      requiresEndpoint: false,
    },
    {
      name: 'llama-3.3-70b-instruct-maas',
      category: 'pure',
      description: 'Llama 3.3 70B for all roles via Model Garden MaaS',
      roles: {
        reasoning:      { provider: 'model-garden', model: 'llama-3.3-70b-instruct-maas', maxTokens: 2048, temperature: 0.7 },
        content:        { provider: 'model-garden', model: 'llama-3.3-70b-instruct-maas', maxTokens: 1536, temperature: 0.8 },
        classification: { provider: 'model-garden', model: 'llama-3.3-70b-instruct-maas', maxTokens: 512, temperature: 0.3 },
        validation:     { provider: 'model-garden', model: 'llama-3.3-70b-instruct-maas', maxTokens: 256, temperature: 0.2 },
      },
      requiresEndpoint: false,
    },
    // Mixed presets
    {
      name: 'gemini-3-mixed',
      category: 'mixed',
      description: 'Gemini 3 Pro reasoning + 3 Flash for content/classification/validation',
      roles: {
        reasoning:      { provider: 'google', model: 'gemini-3-pro-preview', maxTokens: 2048, temperature: 0.7 },
        content:        { provider: 'google', model: 'gemini-3-flash-preview', maxTokens: 1536, temperature: 0.8 },
        classification: { provider: 'google', model: 'gemini-3-flash-preview', maxTokens: 512, temperature: 0.3 },
        validation:     { provider: 'google', model: 'gemini-3-flash-preview', maxTokens: 256, temperature: 0.2 },
      },
      requiresEndpoint: false,
    },
    {
      name: 'gemini-2.5-mixed',
      category: 'mixed',
      description: 'Gemini 2.5 Pro reasoning + 2.5 Flash Lite for content/classification/validation',
      roles: {
        reasoning:      { provider: 'google', model: 'gemini-2.5-pro', maxTokens: 2048, temperature: 0.7 },
        content:        { provider: 'google', model: 'gemini-2.5-flash-lite', maxTokens: 1536, temperature: 0.8 },
        classification: { provider: 'google', model: 'gemini-2.5-flash-lite', maxTokens: 512, temperature: 0.3 },
        validation:     { provider: 'google', model: 'gemini-2.5-flash-lite', maxTokens: 256, temperature: 0.2 },
      },
      requiresEndpoint: false,
    },
    {
      name: 'gemini-2.0-mixed',
      category: 'mixed',
      description: 'Gemini 2.0 Flash reasoning + 2.0 Flash Lite for content/classification/validation',
      roles: {
        reasoning:      { provider: 'google', model: 'gemini-2.0-flash', maxTokens: 2048, temperature: 0.7 },
        content:        { provider: 'google', model: 'gemini-2.0-flash-lite', maxTokens: 1536, temperature: 0.8 },
        classification: { provider: 'google', model: 'gemini-2.0-flash-lite', maxTokens: 512, temperature: 0.3 },
        validation:     { provider: 'google', model: 'gemini-2.0-flash-lite', maxTokens: 256, temperature: 0.2 },
      },
      requiresEndpoint: false,
    },
    // Production
    {
      name: 'production',
      category: 'production',
      description: 'Gemini 3 Pro reasoning + 2.5 Flash Lite for speed — default production preset',
      roles: {
        reasoning:      { provider: 'google', model: 'gemini-3-pro-preview', maxTokens: 2048, temperature: 0.7 },
        content:        { provider: 'google', model: 'gemini-2.5-flash-lite', maxTokens: 1536, temperature: 0.8 },
        classification: { provider: 'google', model: 'gemini-2.5-flash-lite', maxTokens: 512, temperature: 0.3 },
        validation:     { provider: 'google', model: 'gemini-2.5-flash-lite', maxTokens: 256, temperature: 0.2 },
      },
      requiresEndpoint: false,
    },
    // Model Garden
    {
      name: 'llama-3.2-3b',
      category: 'model-garden',
      description: 'Gemini 2.0 Flash reasoning + Llama 3.2 3B content (serverless MaaS)',
      roles: {
        reasoning:      { provider: 'google', model: 'gemini-2.0-flash', maxTokens: 2048, temperature: 0.7 },
        content:        { provider: 'model-garden', model: 'llama-3.2-3b-instruct-maas', maxTokens: 1536, temperature: 0.8 },
        classification: { provider: 'model-garden', model: 'llama-3.2-3b-instruct-maas', maxTokens: 512, temperature: 0.3 },
        validation:     { provider: 'model-garden', model: 'llama-3.2-3b-instruct-maas', maxTokens: 256, temperature: 0.2 },
      },
      requiresEndpoint: false,
    },
    {
      name: 'mistral-small',
      category: 'model-garden',
      description: 'Gemini 2.0 Flash reasoning + Mistral Small content (serverless MaaS)',
      roles: {
        reasoning:      { provider: 'google', model: 'gemini-2.0-flash', maxTokens: 2048, temperature: 0.7 },
        content:        { provider: 'model-garden', model: 'mistral-small-2503', maxTokens: 1536, temperature: 0.8 },
        classification: { provider: 'model-garden', model: 'mistral-small-2503', maxTokens: 512, temperature: 0.3 },
        validation:     { provider: 'model-garden', model: 'mistral-small-2503', maxTokens: 256, temperature: 0.2 },
      },
      requiresEndpoint: false,
    },
    // Gemma (require dedicated GPU endpoint)
    {
      name: 'gemma-3-4b',
      category: 'gemma',
      description: 'Gemini 2.0 Flash reasoning + Gemma 3 4B content (requires GPU endpoint)',
      roles: {
        reasoning:      { provider: 'google', model: 'gemini-2.0-flash', maxTokens: 2048, temperature: 0.7 },
        content:        { provider: 'vertex-endpoint', model: 'gemma-3-4b-it', maxTokens: 1536, temperature: 0.8 },
        classification: { provider: 'google', model: 'gemini-2.0-flash-lite', maxTokens: 512, temperature: 0.3 },
        validation:     { provider: 'google', model: 'gemini-2.0-flash-lite', maxTokens: 256, temperature: 0.2 },
      },
      requiresEndpoint: true,
    },
    {
      name: 'gemma-3-12b',
      category: 'gemma',
      description: 'Gemini 2.0 Flash reasoning + Gemma 3 12B content (requires GPU endpoint)',
      roles: {
        reasoning:      { provider: 'google', model: 'gemini-2.0-flash', maxTokens: 2048, temperature: 0.7 },
        content:        { provider: 'vertex-endpoint', model: 'gemma-3-12b-it', maxTokens: 1536, temperature: 0.8 },
        classification: { provider: 'google', model: 'gemini-2.0-flash-lite', maxTokens: 512, temperature: 0.3 },
        validation:     { provider: 'google', model: 'gemini-2.0-flash-lite', maxTokens: 256, temperature: 0.2 },
      },
      requiresEndpoint: true,
    },
  ];
  return presets;
}

app.get('/api/presets', (_req: Request, res: Response) => {
  const presets = getPresetList();
  const currentPreset = process.env.MODEL_PRESET || 'production';
  res.json({
    currentPreset,
    totalPresets: presets.length,
    presets,
  });
});

// ============================================
// GET /api/benchmark - Benchmark presets with timing comparison
// ============================================

interface BenchmarkResult {
  preset: string;
  category: string;
  timings: {
    classification: { duration: number; model: string; tokens?: { input: number; output: number } } | { error: string };
    reasoning: { duration: number; model: string; tokens?: { input: number; output: number } } | { error: string };
  };
  totalDuration: number;
  status: 'success' | 'partial' | 'failed';
}

app.get('/api/benchmark', async (req: Request, res: Response) => {
  const query = (req.query.query as string) || 'best espresso machine for beginners';
  const presetsParam = req.query.presets as string | undefined;

  // Parse which presets to benchmark
  const allPresets = getPresetList();
  let targetPresets: string[];
  if (presetsParam) {
    targetPresets = presetsParam.split(',').map((p) => p.trim());
  } else {
    // Default: benchmark all non-endpoint presets
    targetPresets = allPresets
      .filter((p) => !p.requiresEndpoint)
      .map((p) => p.name);
  }

  const classificationPrompt = `Classify the following user query into one of these intent types: discovery, comparison, product-detail, use-case, specs, reviews, price, recommendation, support, gift, beginner, upgrade, technique.

Query: "${query}"

Respond with JSON: {"intentType": "...", "confidence": 0.0-1.0, "entities": {"products": [], "useCases": [], "features": []}, "journeyStage": "exploring|comparing|deciding"}`;

  const reasoningPrompt = `You are an expert coffee equipment recommender. Given this query, select 3-4 content blocks from this list: hero, cards, columns, accordion, tabs, table, testimonials, product-detail, product-list, follow-up.

Query: "${query}"

Respond with JSON: {"blocks": [{"type": "...", "priority": 1, "rationale": "..."}], "reasoning": "..."}`;

  const results: BenchmarkResult[] = [];
  const overallStart = Date.now();

  for (const presetName of targetPresets) {
    const presetInfo = allPresets.find((p) => p.name === presetName);
    if (!presetInfo) continue;

    const result: BenchmarkResult = {
      preset: presetName,
      category: presetInfo.category,
      timings: {
        classification: { error: 'not run' },
        reasoning: { error: 'not run' },
      },
      totalDuration: 0,
      status: 'failed',
    };

    const presetStart = Date.now();

    try {
      const factory = new GoogleModelFactory(presetName);

      // Benchmark classification
      try {
        const classStart = Date.now();
        const classResponse = await factory.call('classification', [
          { role: 'user', content: classificationPrompt },
        ]);
        result.timings.classification = {
          duration: Date.now() - classStart,
          model: classResponse.model,
          tokens: classResponse.usage
            ? { input: classResponse.usage.inputTokens, output: classResponse.usage.outputTokens }
            : undefined,
        };
      } catch (err) {
        result.timings.classification = { error: err instanceof Error ? err.message : 'Unknown error' };
      }

      // Benchmark reasoning
      try {
        const reasonStart = Date.now();
        const reasonResponse = await factory.call('reasoning', [
          { role: 'user', content: reasoningPrompt },
        ]);
        result.timings.reasoning = {
          duration: Date.now() - reasonStart,
          model: reasonResponse.model,
          tokens: reasonResponse.usage
            ? { input: reasonResponse.usage.inputTokens, output: reasonResponse.usage.outputTokens }
            : undefined,
        };
      } catch (err) {
        result.timings.reasoning = { error: err instanceof Error ? err.message : 'Unknown error' };
      }

      result.totalDuration = Date.now() - presetStart;

      const classOk = !('error' in result.timings.classification);
      const reasonOk = !('error' in result.timings.reasoning);
      if (classOk && reasonOk) result.status = 'success';
      else if (classOk || reasonOk) result.status = 'partial';
    } catch (err) {
      result.totalDuration = Date.now() - presetStart;
      console.error(`[benchmark] Preset ${presetName} failed:`, err);
    }

    results.push(result);
  }

  // Build summary table sorted by total duration
  const successful = results.filter((r) => r.status === 'success');
  successful.sort((a, b) => a.totalDuration - b.totalDuration);

  const summary = successful.map((r) => {
    const classTime = 'duration' in r.timings.classification ? r.timings.classification.duration : null;
    const reasonTime = 'duration' in r.timings.reasoning ? r.timings.reasoning.duration : null;
    const classModel = 'model' in r.timings.classification ? r.timings.classification.model : 'N/A';
    const reasonModel = 'model' in r.timings.reasoning ? r.timings.reasoning.model : 'N/A';
    return {
      preset: r.preset,
      category: r.category,
      classificationMs: classTime,
      classificationModel: classModel,
      reasoningMs: reasonTime,
      reasoningModel: reasonModel,
      totalMs: r.totalDuration,
    };
  });

  res.json({
    query,
    benchmarkedPresets: results.length,
    totalDuration: Date.now() - overallStart,
    summary,
    details: results,
  });
});

// ============================================
// GET /api/benchmark-full - Full pipeline benchmark
// ============================================

interface FullBenchmarkResult {
  preset: string;
  category: string;
  totalDuration: number;
  blocks: number;
  phases: {
    classification?: number;
    reasoning?: number;
    generation?: number;
  };
  status: 'success' | 'failed';
  error?: string;
}

app.get('/api/benchmark-full', async (req: Request, res: Response) => {
  const query = (req.query.query as string) || 'best espresso machine for beginners';
  const presetsParam = req.query.presets as string | undefined;

  const allPresets = getPresetList();
  let targetPresets: string[];
  if (presetsParam) {
    targetPresets = presetsParam.split(',').map((p) => p.trim());
  } else {
    targetPresets = allPresets
      .filter((p) => !p.requiresEndpoint)
      .map((p) => p.name);
  }

  const results: FullBenchmarkResult[] = [];
  const overallStart = Date.now();

  for (const presetName of targetPresets) {
    const presetInfo = allPresets.find((p) => p.name === presetName);
    if (!presetInfo) continue;

    console.log(`[benchmark-full] Testing preset: ${presetName}`);
    const presetStart = Date.now();

    // Collect timing data from SSE events
    let blocks = 0;
    let classificationMs: number | undefined;
    let reasoningMs: number | undefined;
    let generationCompleteMs: number | undefined;

    try {
      await orchestrate(
        query,
        `benchmark-${presetName}-${Date.now()}`,
        daEnv,
        (event: SSEEvent) => {
          if (event.event === 'reasoning-step' && event.data.stage === 'classification') {
            classificationMs = Date.now() - presetStart;
          }
          if (event.event === 'reasoning-complete') {
            reasoningMs = Date.now() - presetStart;
          }
          if (event.event === 'block-content') {
            blocks++;
          }
          if (event.event === 'generation-complete') {
            generationCompleteMs = event.data.duration;
          }
        },
        undefined,
        presetName,
      );

      const totalDuration = Date.now() - presetStart;
      results.push({
        preset: presetName,
        category: presetInfo.category,
        totalDuration,
        blocks,
        phases: {
          classification: classificationMs,
          reasoning: reasoningMs,
          generation: generationCompleteMs ? generationCompleteMs - (reasoningMs || 0) : undefined,
        },
        status: 'success',
      });

      console.log(`[benchmark-full] ${presetName}: ${totalDuration}ms, ${blocks} blocks`);
    } catch (err) {
      const totalDuration = Date.now() - presetStart;
      results.push({
        preset: presetName,
        category: presetInfo.category,
        totalDuration,
        blocks,
        phases: {},
        status: 'failed',
        error: err instanceof Error ? err.message : 'Unknown error',
      });
      console.error(`[benchmark-full] ${presetName} failed:`, err);
    }
  }

  const successful = results.filter((r) => r.status === 'success');
  successful.sort((a, b) => a.totalDuration - b.totalDuration);

  const summary = successful.map((r) => ({
    preset: r.preset,
    category: r.category,
    blocks: r.blocks,
    classificationMs: r.phases.classification,
    reasoningMs: r.phases.reasoning,
    contentGenerationMs: r.phases.generation,
    totalMs: r.totalDuration,
  }));

  res.json({
    query,
    benchmarkedPresets: results.length,
    totalDuration: Date.now() - overallStart,
    summary,
    details: results,
  });
});

// ============================================
// GET /health and /healthz - Health check
// ============================================

app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'arco-recommender',
    version: '1.0.0-google-native',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: NODE_ENV,
    presets: GoogleModelFactory.getAvailablePresets(),
  });
});

app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).send('ok');
});

// ============================================
// Error Handlers
// ============================================

// 404 handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not found',
    endpoints: [
      'GET /generate?query=...',
      'POST /api/persist',
      'GET /api/presets',
      'GET /api/benchmark?query=...&presets=...',
      'GET /api/benchmark-full?query=...&presets=...',
      'GET /health',
    ],
  });
});

// Global error handler
app.use((err: Error, _req: Request, res: Response, _next: any) => {
  console.error('[server] Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: NODE_ENV === 'development' ? err.message : undefined,
  });
});

// ============================================
// Start Server
// ============================================

const server = app.listen(PORT, () => {
  console.log(`
  ================================================
  Arco Recommender (Google-Native)
  ================================================
  Port:        ${PORT}
  Environment: ${NODE_ENV}
  Presets:     ${GoogleModelFactory.getAvailablePresets().join(', ')}
  DA Org:      ${daEnv.DA_ORG}
  DA Repo:     ${daEnv.DA_REPO}
  ================================================
  `);
});

// ============================================
// Graceful Shutdown
// ============================================

function gracefulShutdown(signal: string) {
  console.log(`\n[server] ${signal} received. Shutting down gracefully...`);
  server.close(() => {
    console.log('[server] HTTP server closed');
    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error('[server] Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default app;
