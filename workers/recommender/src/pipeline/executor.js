/**
 * Flow Executor — runs a configurable sequence of pipeline steps.
 * Steps are either sequential `{ step, config? }` or concurrent `{ parallel: [...] }`.
 */

import { STEPS } from './steps/index.js';

/**
 * Execute a flow (array of step entries) against a pipeline context.
 * Stops early if ctx.aborted or ctx.earlyResponse is set by any step.
 * Records per-step timings in ctx.timings.steps[].
 */
// eslint-disable-next-line import/prefer-default-export
export async function executeFlow(flowSteps, ctx, env) {
  if (!ctx.timings.steps) ctx.timings.steps = [];

  // eslint-disable-next-line no-restricted-syntax
  for (const entry of flowSteps) {
    if (ctx.earlyResponse) return;

    if (entry.parallel) {
      const names = entry.parallel.map((s) => s.step);
      const stepStart = Date.now();
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(
        entry.parallel.map((s) => STEPS[s.step](ctx, s.config || {}, env)),
      );
      ctx.timings.steps.push({ step: names.join(' + '), ms: Date.now() - stepStart, parallel: true });
    } else {
      const stepStart = Date.now();
      // eslint-disable-next-line no-await-in-loop
      await STEPS[entry.step](ctx, entry.config || {}, env);
      ctx.timings.steps.push({ step: entry.step, ms: Date.now() - stepStart }); // eslint-disable-line max-len
    }
  }
}
