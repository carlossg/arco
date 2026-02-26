/**
 * Arco Recommender - Cloud Run Service (Google-Native)
 *
 * Express HTTP server that powers AI-driven Arco coffee equipment recommendations.
 * Uses Gemini + Vertex AI Model Garden with passwordless authentication.
 *
 * Endpoints:
 * - GET /generate?query=...&slug=...&ctx=... - Stream page generation via SSE
 * - POST /api/persist - Persist generated pages to AEM DA
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
  DA_ORG: process.env.DA_ORG || 'carlossg',
  DA_REPO: process.env.DA_REPO || 'arco',
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
