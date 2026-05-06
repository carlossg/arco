export interface Message {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CallResult {
  ttftMs: number;       // time to first token
  totalMs: number;      // total wall-clock time
  outputTokens: number; // may be 0 if provider doesn't report
  error?: string;       // set if the call failed
}

export interface Provider {
  label: string;
  call(messages: Message[]): Promise<CallResult>;
}

export interface ProviderStats {
  label: string;
  samples: number;
  errors: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  ttftMeanMs: number;
  tokensPerSec: number;
  rawTotalMs: number[];
  rawTtftMs: number[];
}

export function computeStats(label: string, results: CallResult[]): ProviderStats {
  const successes = results.filter((r) => !r.error);
  const errors = results.length - successes.length;

  if (successes.length === 0) {
    return {
      label,
      samples: results.length,
      errors,
      meanMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      ttftMeanMs: 0,
      tokensPerSec: 0,
      rawTotalMs: [],
      rawTtftMs: [],
    };
  }

  const totalMs = successes.map((r) => r.totalMs).sort((a, b) => a - b);
  const ttftMs = successes.map((r) => r.ttftMs).sort((a, b) => a - b);
  const totalTokens = successes.reduce((s, r) => s + r.outputTokens, 0);
  const totalTime = successes.reduce((s, r) => s + r.totalMs, 0);

  const p = (arr: number[], pct: number) => arr[Math.floor((arr.length - 1) * pct)];
  const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

  return {
    label,
    samples: results.length,
    errors,
    meanMs: Math.round(mean(totalMs)),
    p50Ms: Math.round(p(totalMs, 0.5)),
    p95Ms: Math.round(p(totalMs, 0.95)),
    ttftMeanMs: Math.round(mean(ttftMs)),
    tokensPerSec: totalTime > 0 ? Math.round((totalTokens / totalTime) * 1000) : 0,
    rawTotalMs: totalMs,
    rawTtftMs: ttftMs,
  };
}
