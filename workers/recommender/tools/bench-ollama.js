/**
 * bench-ollama.js — backend benchmark harness for the local Ollama runtime.
 *
 * POSTs each query in an eval suite to a locally-running worker
 * (`wrangler dev` on :8788) and reports, per query, the accurate phase metrics
 * read from the worker's debug frame (which derives them from Ollama's native
 * eval counters — see src/providers/ollama.js):
 *
 *   - ttft        wall-clock time to first streamed token (ms) — load + prefill
 *                 (+ thinking, for reasoning models)
 *   - prefill     prompt tokens, prompt-eval ms, prefill tokens/sec
 *   - decode      output tokens, generation ms, decode tokens/sec (the headline)
 *   - total       end-to-end wall time (ms)
 *
 * Usage:
 *   node tools/bench-ollama.js [suiteId] [--url http://localhost:8788] [--out report.json] [--runs 1]
 *
 * Defaults: suite=coffee-dev, url=http://localhost:8788, out=stdout only, runs=1.
 * The model is whatever the worker resolves (set OLLAMA_MODEL in .dev.vars).
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUITES_DIR = path.resolve(HERE, '../../../eval/suites');

function parseArgs(argv) {
  const args = {
    suiteId: 'coffee-dev', url: 'http://localhost:8788', out: null, runs: 1,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--url') { i += 1; args.url = argv[i]; } else if (a === '--out') { i += 1; args.out = argv[i]; } else if (a === '--runs') { i += 1; args.runs = Math.max(1, parseInt(argv[i], 10) || 1); } else if (!a.startsWith('--')) rest.push(a);
  }
  if (rest[0]) args.suiteId = rest[0];
  return args;
}

function loadSuite(suiteId) {
  const file = path.join(SUITES_DIR, `${suiteId}.json`);
  const suite = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(suite.queries)) throw new Error(`Suite ${suiteId} has no queries`);
  return suite;
}

/**
 * Stream one /api/generate call. Wall-clock total is measured here; all phase
 * metrics are read from the worker's debug frame (accurate Ollama counters).
 */
async function benchOne(baseUrl, query) {
  const t0 = performance.now();
  let sections = 0;
  let llm = {};
  let errored = null;

  const res = await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, sessionId: randomUUID() }),
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    // eslint-disable-next-line no-await-in-loop
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue; // eslint-disable-line no-continue
      let evt;
      try { evt = JSON.parse(trimmed); } catch { continue; } // eslint-disable-line no-continue
      if (evt.type === 'section') sections += 1;
      else if (evt.type === 'debug' && evt.llm) llm = evt.llm;
      else if (evt.type === 'error') errored = evt.message || 'stream error';
    }
  }

  return {
    query,
    error: errored,
    provider: llm.provider ?? null,
    model: llm.model ?? null,
    sections,
    totalMs: Math.round(performance.now() - t0),
    ttftMs: llm.timeToFirstTokenMs ?? null,
    inputTokens: llm.inputTokens ?? null,
    outputTokens: llm.outputTokens ?? null,
    promptEvalMs: llm.promptEvalMs ?? null,
    promptTokensPerSec: llm.promptTokensPerSec ?? null,
    generationMs: llm.generationMs ?? null,
    tokensPerSec: llm.tokensPerSec ?? null,
    thinkingTokens: llm.thinkingTokens ?? null,
    contentTokens: llm.contentTokens ?? null,
    thinkingPct: llm.thinkingPct ?? null,
    thinkingMs: llm.thinkingMs ?? null,
    contentMs: llm.contentMs ?? null,
    doneReason: llm.doneReason ?? null,
  };
}

function fmt(v, width) {
  return String(v ?? '—').padStart(width);
}

function mean(rows, sel) {
  const vals = rows.map(sel).filter((v) => typeof v === 'number');
  if (!vals.length) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const suite = loadSuite(args.suiteId);
  const queries = suite.queries.map((q) => q.query);

  process.stdout.write(
    `\nbench-ollama → ${args.url}  suite=${suite.id} (${queries.length} queries × ${args.runs} run(s))\n\n`,
  );

  const results = [];
  for (let run = 0; run < args.runs; run += 1) {
    for (const query of queries) {
      let r;
      try {
        // eslint-disable-next-line no-await-in-loop
        r = await benchOne(args.url, query);
      } catch (err) {
        r = { query, error: err.message };
      }
      r.run = run;
      results.push(r);
      const label = query.length > 46 ? `${query.slice(0, 43)}...` : query;
      if (r.error) {
        process.stdout.write(`  ✗ ${label}\n      ERROR: ${r.error}\n`);
      } else {
        process.stdout.write(
          `  ✓ ${label}\n`
          + `      TTFT ${fmt(r.ttftMs, 6)}ms | total ${fmt(r.totalMs, 6)}ms | sec ${fmt(r.sections, 2)}\n`
          + `      prefill ${fmt(r.inputTokens, 5)}tok ${fmt(r.promptEvalMs, 6)}ms → ${fmt(r.promptTokensPerSec, 7)} tok/s\n`
          + `      decode  ${fmt(r.outputTokens, 5)}tok ${fmt(r.generationMs, 6)}ms → ${fmt(r.tokensPerSec, 7)} tok/s\n`
          + `      think   ${fmt(r.thinkingTokens, 5)}tok ${fmt(r.thinkingMs, 6)}ms vs content ${fmt(r.contentTokens, 5)}tok ${fmt(r.contentMs, 6)}ms `
          + `(${fmt(r.thinkingPct, 3)}% think, finish=${r.doneReason ?? '—'})\n`,
        );
      }
    }
  }

  const ok = results.filter((r) => !r.error);
  if (ok.length) {
    const r1 = (v) => (v == null ? '—' : Math.round(v));
    const r10 = (v) => (v == null ? '—' : Math.round(v * 10) / 10);
    process.stdout.write(
      `\n  ── averages (n=${ok.length}, model=${ok[0].provider}/${ok[0].model}) ──\n`
      + `  TTFT            : ${r1(mean(ok, (r) => r.ttftMs))} ms\n`
      + `  total           : ${r1(mean(ok, (r) => r.totalMs))} ms\n`
      + `  prefill tok/s   : ${r10(mean(ok, (r) => r.promptTokensPerSec))}  (avg ${r1(mean(ok, (r) => r.inputTokens))} input tok)\n`
      + `  decode tok/s    : ${r10(mean(ok, (r) => r.tokensPerSec))}  (avg ${r1(mean(ok, (r) => r.outputTokens))} output tok)\n`
      + `  thinking share  : ${r1(mean(ok, (r) => r.thinkingPct))}%  (avg ${r1(mean(ok, (r) => r.thinkingTokens))} think / ${r1(mean(ok, (r) => r.contentTokens))} content tok)\n\n`,
    );
  }

  if (args.out) {
    writeFileSync(args.out, JSON.stringify({ suite: suite.id, url: args.url, results }, null, 2));
    process.stdout.write(`  report written to ${args.out}\n\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`bench-ollama failed: ${err.stack || err.message}\n`);
  process.exit(1);
});
