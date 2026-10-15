/**
 * Jev client — thin wrapper around TypeSafe AI's System One decision endpoint
 * (`POST https://api.typesafe.ai/v1/systemone`).
 *
 * Jev is NOT a text-generation model. It takes a `state` (arbitrary JSON) and
 * a map of typed `questions` (choice / score / noul) and returns structured,
 * calibrated answers — no prose, no parsing. See https://docs.typesafe.ai/api
 *
 * This client is deliberately narrow: one function, one question type
 * (`choice`), used for the block-layout fast path in
 * `pipeline/steps/select-layout.js`. Extend with more question types only
 * when a second use case needs them — don't build a generic SDK-in-miniature
 * ahead of need.
 *
 * Auth: Authorization: ****** (TYPESAFE_API_KEY secret).
 */

const JEV_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_MODEL = 'jev-latest';
const DEFAULT_TIMEOUT_MS = 2000;

/**
 * Ask Jev a single `choice` question against a state object.
 * Returns `{ choice, confidence, probabilities, model, usage }` on success,
 * or `null` if the API key is missing, the call fails, or it times out.
 * Callers must treat `null` as "no opinion" and fall back to existing
 * behavior — Jev is a fast path, never a hard dependency.
 *
 * @param {object} params
 * @param {string} params.apiKey - TYPESAFE_API_KEY
 * @param {string|object} params.state - context to evaluate
 * @param {string} params.instructions - what the model should decide
 * @param {Record<string, string|null>} params.criteria - option -> description map
 * @param {number} [params.timeoutMs]
 * @param {typeof fetch} [params.fetchImpl] - injectable for tests
 */
// eslint-disable-next-line import/prefer-default-export
export async function askChoice({
  apiKey,
  state,
  instructions,
  criteria,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  fetchImpl = fetch,
}) {
  if (!apiKey) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(JEV_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        state,
        model: DEFAULT_MODEL,
        questions: {
          decision: { type: 'choice', instructions, criteria },
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null;

    const body = await res.json();
    const answer = body?.answers?.decision;
    if (!answer || answer.type !== 'choice') return null;

    return {
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      model: body.model,
      usage: body.usage,
    };
  } catch {
    // Network error, timeout, abort, malformed JSON — all treated as "no opinion".
    return null;
  } finally {
    clearTimeout(timer);
  }
}
