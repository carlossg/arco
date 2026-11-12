const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/decisions';
export const DECISION_MODEL = 'gemini-decision-1';
export const DECISION_PRICE = 0.10;

export function decisionMode(env, capability) {
  const configured = env[`DECISIONS_${capability.toUpperCase()}_MODE`];
  const mode = configured ?? (
    env.CLOUD_PLATFORM === 'gcp' && env.GEMINI_API_KEY ? 'on' : 'off'
  );
  if (!['off', 'shadow', 'on'].includes(mode)) {
    throw new Error(`Invalid Decisions ${capability} mode; expected off, shadow or on.`);
  }
  return mode;
}

export function layoutProvider(env) {
  const provider = env.LAYOUT_DECISION_PROVIDER
    ?? (env.CLOUD_PLATFORM === 'gcp' && env.GEMINI_API_KEY ? 'gemini' : 'jev');
  if (!['gemini', 'jev', 'off'].includes(provider)) {
    throw new Error('Invalid LAYOUT_DECISION_PROVIDER; expected gemini, jev or off.');
  }
  return provider;
}

export function decisionThreshold(env) {
  const threshold = Number(env.DECISIONS_CONFIDENCE_THRESHOLD ?? 0.7);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error('DECISIONS_CONFIDENCE_THRESHOLD must be between 0 and 1.');
  }
  return threshold;
}

export function validateDecisionConfig(env) {
  const modes = ['classification', 'layout', 'judge'].map((key) => decisionMode(env, key));
  const provider = layoutProvider(env);
  decisionThreshold(env);
  for (const key of ['DECISIONS_TIMEOUT_MS', 'DECISIONS_JUDGE_TIMEOUT_MS']) {
    if (env[key] !== undefined && (!Number.isInteger(Number(env[key]))
      || Number(env[key]) < 1 || Number(env[key]) > 30_000)) {
      throw new Error(`${key} must be an integer between 1 and 30000 ms.`);
    }
  }
  if (!env.GEMINI_API_KEY && (modes[0] !== 'off' || modes[2] !== 'off'
    || (provider === 'gemini' && modes[1] !== 'off'))) {
    throw new Error('Enabled Decisions capabilities require GEMINI_API_KEY.');
  }
}

function validProbability(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateAnswer(answer, question) {
  if (answer?.type !== question.type || !validProbability(answer.confidence)) return false;
  if (question.type === 'noul') {
    return validProbability(answer.noul) && answer.noul >= 0.01 && answer.noul <= 0.99
      && Math.abs(answer.confidence - Math.max(answer.noul, 1 - answer.noul)) < 0.02;
  }
  const keys = question.type === 'choice'
    ? Object.keys(question.criteria) : question.criteria.map((_, index) => String(index));
  const { probabilities } = answer;
  if (!probabilities || Object.keys(probabilities).length !== keys.length
    || keys.some((key) => !validProbability(probabilities[key]))) return false;
  const sum = keys.reduce((total, key) => total + probabilities[key], 0);
  if (Math.abs(sum - 1) > 0.02) return false;
  const maximum = Math.max(...Object.values(probabilities));
  if (Math.abs(answer.confidence - maximum) > 0.02) return false;
  if (question.type === 'choice') {
    return keys.includes(answer.choice)
      && Math.abs(probabilities[answer.choice] - maximum) < 0.001;
  }
  const expected = keys.reduce((total, key) => total + Number(key) * probabilities[key], 0);
  return Number.isFinite(answer.score) && answer.score >= 0 && answer.score <= keys.length - 1
    && Math.abs(answer.score - expected) < 0.05;
}

export async function askDecisions({
  apiKey, input, questions, timeoutMs = 2000, signal, fetchImpl = fetch,
}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is required for Decisions.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error('Decisions timeout must be an integer between 1 and 30000 ms.');
  }
  const started = Date.now();
  const requestSignal = signal
    ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(ENDPOINT, {
    method: 'POST',
    headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: DECISION_MODEL,
      input: typeof input === 'string' ? input : JSON.stringify(input),
      questions,
    }),
    signal: requestSignal,
  });
  if (!response.ok) {
    await response.body?.cancel();
    const error = new Error(`Decisions request failed (HTTP ${response.status}).`);
    error.status = response.status;
    throw error;
  }
  const body = await response.json();
  if (!body.answers || Object.entries(questions).some(
    ([key, question]) => !validateAnswer(body.answers[key], question),
  )) throw new Error('Decisions returned invalid typed answers.');
  const inputTokens = body.usage?.total_input_tokens;
  if (!Number.isInteger(inputTokens) || inputTokens < 0
    || body.usage?.total_output_tokens !== 0) {
    throw new Error('Decisions returned invalid token usage.');
  }
  return {
    answers: Object.fromEntries(Object.keys(questions).map((key) => {
      const answer = body.answers[key];
      return [key, {
        type: answer.type,
        confidence: answer.confidence,
        ...(answer.type === 'noul' ? { noul: answer.noul } : {
          probabilities: answer.probabilities,
          ...(answer.type === 'choice' ? { choice: answer.choice } : { score: answer.score }),
        }),
      }];
    })),
    model: DECISION_MODEL,
    inputTokens,
    outputTokens: 0,
    costUsd: (inputTokens * DECISION_PRICE) / 1_000_000,
    durationMs: Date.now() - started,
  };
}

export function acceptedDecision(ctx, key) {
  const result = ctx.decisions;
  const answer = result?.answers?.[key];
  if (result?.classificationMode !== 'on' || !answer) return null;
  return answer.confidence >= result.threshold ? answer : null;
}
