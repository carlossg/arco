import { runBenchmarks } from './runner.js';
import type { Env } from './runner.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // POST /run — trigger a benchmark run in the background
  if (request.method === 'POST' && url.pathname === '/run') {
    ctx.waitUntil(
      runBenchmarks(env).catch((err) => console.error('Benchmark run failed:', err)),
    );
    return json({ status: 'started', message: 'Benchmark running in background. Poll GET /results/latest for results.' });
  }

  // GET /results/latest — return latest result from KV
  if (request.method === 'GET' && url.pathname === '/results/latest') {
    const latest = await env.RESULTS_KV.get('latest');
    if (!latest) return json({ error: 'No results yet. POST /run to start a benchmark.' }, 404);
    return new Response(latest, {
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  // GET /results/history — list archived runs from R2
  if (request.method === 'GET' && url.pathname === '/results/history') {
    const listed = await env.RESULTS_R2.list();
    const runs = listed.objects.map((o) => ({
      key: o.key,
      size: o.size,
      uploaded: o.uploaded,
    }));
    return json({ runs });
  }

  // GET /results/:key — fetch a specific archived run from R2
  if (request.method === 'GET' && url.pathname.startsWith('/results/')) {
    const key = url.pathname.slice('/results/'.length);
    const obj = await env.RESULTS_R2.get(key);
    if (!obj) return json({ error: `Not found: ${key}` }, 404);
    return new Response(obj.body, {
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  // GET / — brief API reference
  if (request.method === 'GET' && url.pathname === '/') {
    return json({
      name: 'arco-benchmark-worker',
      endpoints: {
        'POST /run': 'Trigger a benchmark run (non-blocking, runs in background)',
        'GET /results/latest': 'Latest benchmark results from KV',
        'GET /results/history': 'List all archived runs in R2',
        'GET /results/:key': 'Fetch a specific archived run by key',
      },
      cron: '0 6 * * 1 (Mondays 06:00 UTC)',
    });
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handleRequest(request, env, ctx);
  },

  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      runBenchmarks(env)
        .then((result) =>
          console.log(
            `Scheduled benchmark complete in ${result.durationMs}ms, ` +
            `runId=${result.runId}, ` +
            `providers=${result.classification.length}`,
          ),
        )
        .catch((err) => console.error('Scheduled benchmark failed:', err)),
    );
  },
};
